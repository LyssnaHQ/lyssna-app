//! Sign-in to the user's Lyssna account (lyrics submissions, reviews and
//! notifications). The browser signs in on lyssna.org and hands a one-time
//! code back to a loopback listener; the code is exchanged with a PKCE
//! verifier for an access and refresh token pair kept in the credential store.

use std::{
    net::TcpListener,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::{
    StatusCode,
    blocking::{Client, RequestBuilder},
};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

use crate::auth::{challenge, random_string, read_target, reply};
use crate::credential::{Entry, Error as CredentialError};
use crate::model::Track;

pub const API: &str = "https://api.lyssna.org";
const WEB: &str = "https://lyssna.org";
const CALLBACK_PATH: &str = "/cb";

// The desktop app's project on api.lyssna.org. Builds can point at another project with
// LYSSNA_CLIENT_ID and LYSSNA_KEY. The key is publishable, not a secret: it names the project
// and anyone can read it out of the app. Requests also carry this copy's install id.
pub const CLIENT_ID: &str = match option_env!("LYSSNA_CLIENT_ID") {
    Some(id) => id,
    None => "01a1f5b3-3428-7ce0-918c-894bd775c2bd",
};
pub const PUBLISHABLE_KEY: &str = match option_env!("LYSSNA_KEY") {
    Some(key) => key,
    None => "lk_pub_4qv4iYxKjDz6pp0vDQOWJ4cAi6JM3LMb",
};

/// Adds the project's publishable key, and this copy's install id, to a request for
/// api.lyssna.org. The first call on a new install registers it.
pub(crate) fn keyed(request: RequestBuilder) -> RequestBuilder {
    let request = with_key(request, PUBLISHABLE_KEY);
    match crate::lyssna_install::header(API, PUBLISHABLE_KEY) {
        Some(install) => request.header("Lyssna-Install", install),
        None => request,
    }
}

fn with_key(request: RequestBuilder, key: &str) -> RequestBuilder {
    if key.is_empty() {
        request
    } else {
        request.header("Lyssna-Key", key)
    }
}
const CREDENTIAL_SERVICE: &str = "Lyssna/Account";
const CREDENTIAL_USER: &str = "tokens";

#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    access_expires_at: i64,
    refresh_token: String,
    refresh_expires_at: i64,
}

#[derive(Deserialize)]
struct TokenPair {
    access_token: String,
    access_expires_at: String,
    refresh_token: String,
    refresh_expires_at: String,
}

impl TryFrom<TokenPair> for Tokens {
    type Error = anyhow::Error;
    fn try_from(pair: TokenPair) -> Result<Self> {
        let unix = |text: &str| -> Result<i64> {
            Ok(OffsetDateTime::parse(text, &Rfc3339)
                .context("Lyssna sent an unreadable token expiry")?
                .unix_timestamp())
        };
        Ok(Self {
            access_expires_at: unix(&pair.access_expires_at)?,
            refresh_expires_at: unix(&pair.refresh_expires_at)?,
            access_token: pair.access_token,
            refresh_token: pair.refresh_token,
        })
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub role: String,
    pub reputation: i64,
    pub tier_name: String,
    /// The reputation tier's number; 3 is Trusted.
    #[serde(default)]
    pub tier: i64,
    pub email_verified: bool,
}

#[derive(Deserialize)]
struct MeResponse {
    user: MeUser,
    tier: MeTier,
}
#[derive(Deserialize)]
struct MeUser {
    id: String,
    username: String,
    role: String,
    reputation: i64,
    #[serde(default)]
    tier: i64,
    email_verified: bool,
}
#[derive(Deserialize)]
struct MeTier {
    name: String,
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    error: Option<String>,
    message: Option<String>,
}

// Refresh tokens rotate on use, so two refreshes racing would sign the user out.
static TOKENS: Mutex<()> = Mutex::new(());

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn entry() -> Result<Entry> {
    Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER).context("Credential store unavailable")
}

fn load() -> Result<Option<Tokens>> {
    match entry()?.get_password() {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(CredentialError::NoEntry) => Ok(None),
        Err(error) => Err(anyhow::anyhow!("Cannot read saved Lyssna sign-in: {error}")),
    }
}

fn save(tokens: &Tokens) -> Result<()> {
    entry()?
        .set_password(&serde_json::to_string(tokens)?)
        .context("Cannot save Lyssna sign-in")
}

fn forget() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(CredentialError::NoEntry) => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "Cannot remove saved Lyssna sign-in: {error}"
        )),
    }
}

/// An error answer from the API, read once so callers can look at its code first.
struct Rejection {
    status: StatusCode,
    retry_after: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

fn rejection(response: reqwest::blocking::Response) -> Rejection {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.json::<ApiError>().unwrap_or(ApiError {
        error: None,
        message: None,
    });
    if body.error.as_deref() == Some("install_required") {
        // the API no longer knows this install: register a new one on the next request
        crate::lyssna_install::forget();
    }
    Rejection {
        status,
        retry_after,
        code: body.error,
        message: body.message,
    }
}

/// Plain wording for the errors every route can answer with.
fn friendly(status: StatusCode, code: Option<&str>, retry_after: Option<&str>) -> Option<String> {
    if status == StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after
            .and_then(|text| text.trim().parse::<u64>().ok())
            .filter(|seconds| *seconds > 0);
        return Some(match wait {
            Some(seconds) => format!("Lyssna is busy. Try again in {seconds} seconds"),
            None => "Lyssna is busy. Try again in a moment".to_owned(),
        });
    }
    let text = match code? {
        "token_app_mismatch" => "This sign-in belongs to another app. Sign in again from Settings",
        "insufficient_scope" => "This sign-in cannot do that. Sign in again from Settings",
        "app_suspended" => "Lyssna has paused this app. Try again later",
        "blocked" => "Lyssna has blocked requests from your network",
        "invalid_key" => "This copy of Lyssna has an invalid API key. Update the app",
        "install_required" => "Lyssna needs to register this copy again. Try once more",
        _ => return None,
    };
    Some(text.to_owned())
}

impl Rejection {
    fn friendly(&self) -> Option<String> {
        friendly(
            self.status,
            self.code.as_deref(),
            self.retry_after.as_deref(),
        )
    }
    fn into_error(self) -> anyhow::Error {
        match (self.friendly(), self.message) {
            (Some(text), _) => anyhow::anyhow!("{text}"),
            (None, Some(message)) => anyhow::anyhow!("{message}"),
            (None, None) => anyhow::anyhow!("Lyssna answered {}", self.status),
        }
    }
}

fn failure(response: reqwest::blocking::Response) -> anyhow::Error {
    rejection(response).into_error()
}

fn request_tokens(client: &Client, body: &serde_json::Value) -> Result<Tokens> {
    let response = keyed(client.post(format!("{API}/v1/auth/token")))
        .json(body)
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        return Err(failure(response));
    }
    response.json::<TokenPair>()?.try_into()
}

fn sign_in_url(client_id: &str, redirect_uri: &str, verifier: &str, state: &str) -> Result<Url> {
    let mut url = Url::parse(&format!("{WEB}/authorize"))?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("state", state),
        ("code_challenge", &challenge(verifier)),
        ("code_challenge_method", "S256"),
    ]);
    Ok(url)
}

/// The code from a loopback callback, after checking its path and state.
fn callback_code(target: &str, state: &str) -> Result<String> {
    let url = Url::parse(&format!("http://127.0.0.1{target}"))?;
    ensure!(url.path() == CALLBACK_PATH, "Unexpected callback path");
    let field = |name: &str| -> Result<Option<String>> {
        let values: Vec<_> = url.query_pairs().filter(|(key, _)| key == name).collect();
        ensure!(values.len() <= 1, "Duplicate callback parameter");
        Ok(values.first().map(|(_, value)| value.to_string()))
    };
    ensure!(
        field("state")?.as_deref() == Some(state),
        "Sign-in state did not match"
    );
    let code = field("code")?.context("Lyssna did not return a sign-in code")?;
    ensure!(!code.is_empty(), "Lyssna returned an empty sign-in code");
    Ok(code)
}

fn wait_for_code(listener: &TcpListener, state: &str, cancelled: &AtomicBool) -> Result<String> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        ensure!(!cancelled.load(Ordering::Relaxed), "Sign-in cancelled");
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let Ok(target) = read_target(&mut stream) else {
                    reply(&mut stream, "400 Bad Request", "Invalid callback request.");
                    continue;
                };
                match callback_code(&target, state) {
                    Ok(code) => {
                        reply(
                            &mut stream,
                            "200 OK",
                            "Signed in. Return to Lyssna to finish.",
                        );
                        return Ok(code);
                    }
                    // A stray local request must not end the real sign-in.
                    Err(_) => reply(&mut stream, "400 Bad Request", "Sign-in callback rejected."),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(error) => return Err(error.into()),
        }
    }
    bail!("Lyssna sign-in timed out after five minutes. Start it again from Settings.")
}

pub fn sign_in(client: &Client, cancelled: &AtomicBool) -> Result<Account> {
    ensure!(
        !CLIENT_ID.is_empty(),
        "This build of Lyssna cannot sign in yet. Update the app"
    );
    let verifier = random_string()?;
    let state = random_string()?;
    let listener = TcpListener::bind("127.0.0.1:0").context("Cannot open a local sign-in port")?;
    let redirect_uri = format!(
        "http://127.0.0.1:{}{CALLBACK_PATH}",
        listener.local_addr()?.port()
    );
    let url = sign_in_url(CLIENT_ID, &redirect_uri, &verifier, &state)?;
    webbrowser::open(url.as_str()).context("Cannot open the browser to sign in to Lyssna")?;
    let code = wait_for_code(&listener, &state, cancelled)?;
    let tokens = request_tokens(
        client,
        &serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
        }),
    )?;
    {
        let _guard = TOKENS.lock().unwrap_or_else(|error| error.into_inner());
        save(&tokens)?;
    }
    account(client)?.context("Lyssna did not accept the new sign-in")
}

/// A usable access token, refreshing it first when it is about to expire.
/// `None` when signed out or the saved sign-in is no longer accepted.
fn access_token(client: &Client) -> Result<Option<String>> {
    let _guard = TOKENS.lock().unwrap_or_else(|error| error.into_inner());
    let Some(tokens) = load()? else {
        return Ok(None);
    };
    if tokens.access_expires_at - now() > 60 {
        return Ok(Some(tokens.access_token));
    }
    if tokens.refresh_expires_at <= now() {
        forget()?;
        return Ok(None);
    }
    let response = keyed(client.post(format!("{API}/v1/auth/token")))
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "refresh_token": tokens.refresh_token,
        }))
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        // A bad API key says nothing about the sign-in, so it stays.
        let sign_in_refused = matches!(
            rejected.status,
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED
        ) && rejected.code.as_deref() != Some("invalid_key");
        if sign_in_refused {
            forget()?;
            return Ok(None);
        }
        return Err(rejected.into_error());
    }
    let fresh: Tokens = response.json::<TokenPair>()?.try_into()?;
    save(&fresh)?;
    Ok(Some(fresh.access_token))
}

/// The signed-in account, or `None` when signed out.
pub fn account(client: &Client) -> Result<Option<Account>> {
    let Some(token) = access_token(client)? else {
        return Ok(None);
    };
    let response = keyed(client.get(format!("{API}/v1/me")))
        .bearer_auth(token)
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        if rejected.status == StatusCode::UNAUTHORIZED
            && rejected.code.as_deref() != Some("invalid_key")
        {
            let _guard = TOKENS.lock().unwrap_or_else(|error| error.into_inner());
            forget()?;
            return Ok(None);
        }
        return Err(rejected.into_error());
    }
    let me: MeResponse = response.json()?;
    Ok(Some(Account {
        id: me.user.id,
        username: me.user.username,
        role: me.user.role,
        reputation: me.user.reputation,
        tier_name: me.tier.name,
        tier: me.user.tier,
        email_verified: me.user.email_verified,
    }))
}

/// What Lyssna made of an uploaded TTML.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Submission {
    pub id: String,
    #[serde(default)]
    pub song_id: Option<String>,
    pub song_title: String,
    /// `new` or `edit`.
    pub kind: String,
    /// `approved` when the submitter's role skips review, otherwise `pending`.
    pub status: String,
}

// The API takes authored dates from 2015 on, and not in the future.
const EARLIEST_AUTHORED: i64 = 1_420_070_400;
// A little slack so a file saved just now is not ahead of the server's clock.
const AUTHORED_SLACK: i64 = 60;

/// The RFC 3339 time the lyrics were made, or `None` when it is unreadable or out of the API's range.
fn authored_at(text: &str, now: OffsetDateTime) -> Option<String> {
    let at = OffsetDateTime::parse(text.trim(), &Rfc3339).ok()?;
    let seconds = at.unix_timestamp();
    if seconds < EARLIEST_AUTHORED || seconds > now.unix_timestamp() - AUTHORED_SLACK {
        return None;
    }
    at.to_offset(time::UtcOffset::UTC).format(&Rfc3339).ok()
}

/// Lyrics, or `None` for a song with no lyrics: an instrumental.
fn submission_body(
    ttml: Option<&str>,
    track: &Track,
    isrcs: &[String],
    authored: Option<&str>,
) -> Result<serde_json::Value> {
    let id = crate::lyssna_lyrics::spotify_id(track);
    ensure!(
        id.is_some() || !isrcs.is_empty(),
        if track.is_local {
            "Match this local file to an ISRC before submitting lyrics"
        } else {
            "Only Spotify songs can be submitted to Lyssna"
        }
    );
    // The ISRC leads so the song is keyed to the recording rather than one platform's ID; the
    // Spotify link stays so the app's own lookups still find it.
    let mut links = Vec::new();
    if let Some(isrc) = isrcs.first() {
        links.push(serde_json::json!({ "platform": "isrc", "external_id": isrc }));
    }
    if let Some(id) = id {
        links.push(serde_json::json!({ "platform": "spotify", "external_id": id }));
    }
    let mut body = serde_json::json!({
        "links": links,
        "title": track.name,
        "artists": track.artists.iter().map(|artist| &artist.name).collect::<Vec<_>>(),
    });
    match ttml {
        Some(ttml) => body["ttml"] = crate::lyrics::repair_container_timing(ttml).into(),
        None => {
            ensure!(!isrcs.is_empty(), "Spotify has no ISRC for this song");
            body["instrumental"] = true.into();
        }
    }
    if !isrcs.is_empty() {
        body["extra_isrcs"] = isrcs.into();
    }
    if !track.album.name.is_empty() {
        body["album"] = track.album.name.clone().into();
    }
    if let Some(at) = authored.and_then(|text| authored_at(text, OffsetDateTime::now_utc())) {
        body["authored_at"] = at.into();
    }
    Ok(body)
}

fn submit_failure(rejected: Rejection) -> anyhow::Error {
    let known = match rejected.code.as_deref() {
        Some("unverified") => Some("Confirm your email on lyssna.org before submitting lyrics"),
        Some("pending_exists") => Some("This song already has lyrics waiting for review"),
        Some("own_open_edit") => Some("You already have an open submission for this song"),
        Some("no_changes") => Some("These lyrics match what Lyssna already has"),
        Some("has_lyrics") => Some("This song already has lyrics on Lyssna"),
        Some("missing_isrc") => Some("Spotify has no ISRC for this song"),
        _ => None,
    };
    match known {
        Some(text) => anyhow::anyhow!("{text}"),
        None => rejected.into_error(),
    }
}

/// Sends the cover of a song that has none anywhere else, such as one from a
/// file on disk. The API accepts it only from the song's submitter while it
/// has no Spotify link and no cover, or from reviewers.
pub fn upload_cover(client: &Client, song_id: &str, picture: Vec<u8>, mime: &str) -> Result<()> {
    let Some(token) = access_token(client)? else {
        bail!("Sign in to Lyssna first");
    };
    let response = keyed(client.put(format!("{API}/v1/songs/{song_id}/cover")))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(picture)
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        return Err(rejection(response).into_error());
    }
    Ok(())
}

/// Uploads a TTML for the song, linked by its ISRC when Spotify knows it, and its Spotify ID.
/// Every ISRC of the recording goes along, so the song is found under any of them.
pub fn submit(
    client: &Client,
    ttml: Option<&str>,
    track: &Track,
    isrcs: &[String],
    authored: Option<&str>,
    apple: Option<&crate::lyrics::AppleOriginal>,
) -> Result<Submission> {
    let mut body = submission_body(ttml, track, isrcs, authored)?;
    // An edit of Apple Music's sync names it, so Apple keeps the credit for what it timed.
    if let (Some(apple), Some(_)) = (apple, ttml) {
        body["apple_original"] =
            serde_json::json!({ "apple_id": apple.apple_id, "sha256": apple.sha256 });
    }
    let Some(token) = access_token(client)? else {
        bail!("Sign in to Lyssna in Settings to submit lyrics");
    };
    let path = submissions_path(act_as().as_ref());
    let send = |body: &serde_json::Value| {
        keyed(client.post(format!("{API}{path}")))
            .bearer_auth(&token)
            .json(body)
            .send()
            .context("Cannot reach Lyssna")
    };
    let mut response = send(&body)?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        if !drops_apple_credit(&rejected, &mut body) {
            return Err(submit_failure(rejected));
        }
        // Lyssna credits Apple Music only for its word-synced lyrics; a
        // draft saved from its line-synced ones goes up without the credit.
        response = send(&body)?;
        if !response.status().is_success() {
            return Err(submit_failure(rejection(response)));
        }
    }
    Ok(response.json()?)
}

/// Takes the Apple Music credit off `body` when Lyssna refused it because
/// Apple's lyrics for the song are not word-synced.
fn drops_apple_credit(rejected: &Rejection, body: &mut serde_json::Value) -> bool {
    rejected.code.as_deref() == Some("apple_not_word_synced")
        && body
            .as_object_mut()
            .and_then(|fields| fields.remove("apple_original"))
            .is_some()
}

/// Asks Lyssna for lyrics for a Spotify song, counted once per account, or
/// per install when signed out. Answers how many people want them.
pub fn request_lyrics(client: &Client, track: &Track) -> Result<i64> {
    let Some(id) = crate::lyssna_lyrics::spotify_id(track) else {
        bail!("Only Spotify songs can be requested");
    };
    let mut request = keyed(client.post(format!("{API}/v1/tracks/spotify/{id}/request")));
    if let Some(token) = access_token(client)? {
        request = request.bearer_auth(token);
    }
    let response = request.send().context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        let known = match rejected.code.as_deref() {
            Some("has_lyrics") => Some("This song already has lyrics on Lyssna"),
            Some("instrumental") => Some("Lyssna has this song as instrumental"),
            Some("no_isrc") => Some("Spotify has no ISRC for this song"),
            _ => None,
        };
        return Err(match known {
            Some(message) => anyhow!(message),
            None => rejected.into_error(),
        });
    }
    #[derive(Deserialize)]
    struct Requested {
        requests: i64,
    }
    Ok(response.json::<Requested>()?.requests)
}

/// Tally of an ISRC backfill over every song on Lyssna.
#[derive(Clone, Serialize, Debug, Default, PartialEq)]
pub struct IsrcBackfill {
    pub songs: usize,
    pub added: usize,
    pub already: usize,
    pub no_spotify: usize,
    pub no_isrc: usize,
    /// Songs whose ISRC is already linked to a different Lyssna song: likely duplicates.
    pub taken: Vec<String>,
    pub failed: Vec<String>,
}

#[derive(Deserialize)]
struct Listed {
    id: String,
}
#[derive(Deserialize)]
struct Credit {
    song_id: String,
}
#[derive(Deserialize)]
struct LinkedSong {
    title: String,
    #[serde(default)]
    links: Vec<SongLink>,
}
#[derive(Deserialize)]
struct SongLink {
    platform: String,
    external_id: String,
}

const PAGE: usize = 50;

fn get_page<T: serde::de::DeserializeOwned>(client: &Client, token: &str, path: &str) -> Result<T> {
    let response = keyed(client.get(format!("{API}{path}")))
        .bearer_auth(token)
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        if rejected.status == StatusCode::FORBIDDEN && rejected.friendly().is_none() {
            bail!("Only Lyssna admins can add ISRC links to every song");
        }
        return Err(rejected.into_error());
    }
    Ok(response.json()?)
}

fn every<T: serde::de::DeserializeOwned>(
    client: &Client,
    token: &str,
    path: &str,
) -> Result<Vec<T>> {
    let mut found = Vec::new();
    loop {
        let separator = if path.contains('?') { '&' } else { '?' };
        let page: Vec<T> = get_page(
            client,
            token,
            &format!("{path}{separator}limit={PAGE}&offset={}", found.len()),
        )?;
        let done = page.len() < PAGE;
        found.extend(page);
        if done {
            return Ok(found);
        }
    }
}

/// Adds an `isrc` link to every song that only has a Spotify one. There is no
/// endpoint listing all songs, so they are gathered from every account's credits.
pub fn backfill_isrc(
    client: &Client,
    isrc_for: impl Fn(&str) -> Option<String>,
) -> Result<IsrcBackfill> {
    let Some(token) = access_token(client)? else {
        bail!("Sign in to Lyssna in Settings first");
    };
    let mut songs = std::collections::BTreeSet::new();
    for user in every::<Listed>(client, &token, "/v1/users")? {
        for credit in every::<Credit>(
            client,
            &token,
            &format!("/v1/users/{}/contributions", user.id),
        )? {
            songs.insert(credit.song_id);
        }
    }
    let mut report = IsrcBackfill {
        songs: songs.len(),
        ..IsrcBackfill::default()
    };
    for id in songs {
        let song: LinkedSong = match get_page(client, &token, &format!("/v1/songs/{id}")) {
            Ok(song) => song,
            Err(error) => {
                report.failed.push(format!("{id}: {error:#}"));
                continue;
            }
        };
        if song.links.iter().any(|link| link.platform == "isrc") {
            report.already += 1;
            continue;
        }
        let Some(spotify) = song.links.iter().find(|link| link.platform == "spotify") else {
            report.no_spotify += 1;
            continue;
        };
        let Some(isrc) = isrc_for(&spotify.external_id) else {
            report.no_isrc += 1;
            continue;
        };
        let response = keyed(client.post(format!("{API}/v1/songs/{id}/links")))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "platform": "isrc", "external_id": isrc }))
            .send()
            .context("Cannot reach Lyssna")?;
        match response.status() {
            status if status.is_success() => report.added += 1,
            StatusCode::CONFLICT => report.taken.push(format!("{} ({isrc})", song.title)),
            _ => {
                let message = response
                    .json::<ApiError>()
                    .ok()
                    .and_then(|body| body.message.or(body.error))
                    .unwrap_or_default();
                report.failed.push(format!("{}: {message}", song.title));
            }
        }
    }
    Ok(report)
}

/// A request the TTML Creator's Review tab makes for a reviewer.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewMethod {
    Get,
    Post,
}

const REVIEW_LANES: [&str; 2] = ["priority", "backlog"];
const REVIEW_ACTIONS: [&str; 3] = ["approve", "reject", "request-changes"];

fn is_id(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// Checks a review request against the few the Review tab needs, so the
/// command can't be steered at the rest of the account's API.
fn review_request(method: ReviewMethod, path: &str) -> Result<Url> {
    let url = Url::parse(&format!("{API}{path}")).context("Invalid review request")?;
    ensure!(
        url.origin() == Url::parse(API)?.origin() && url.fragment().is_none(),
        "Invalid review request"
    );
    let parts: Vec<&str> = url.path().trim_start_matches('/').split('/').collect();
    let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let plain = query.is_empty();
    let allowed = match (method, parts.as_slice()) {
        (ReviewMethod::Get, ["v1", "queue"]) => {
            query.iter().all(|(key, value)| match key.as_str() {
                "lane" => REVIEW_LANES.contains(&value.as_str()),
                "limit" => value
                    .parse::<u16>()
                    .is_ok_and(|limit| (1..=200).contains(&limit)),
                _ => false,
            })
        }
        (ReviewMethod::Get, ["v1", "submissions" | "songs" | "revisions", id]) => {
            plain && is_id(id)
        }
        (ReviewMethod::Get, ["v1", "submissions", id, "comments"]) => plain && is_id(id),
        (ReviewMethod::Get, ["v1", "revisions", id, "ttml"]) => plain && is_id(id),
        (ReviewMethod::Post, ["v1", "submissions", id, "comments"]) => plain && is_id(id),
        (ReviewMethod::Post, ["v1", "submissions", id, action]) => {
            plain && is_id(id) && REVIEW_ACTIONS.contains(action)
        }
        _ => false,
    };
    ensure!(allowed, "Invalid review request");
    Ok(url)
}

/// A reviewer's request to the API: JSON back, or a revision's TTML as a string.
pub fn review(
    client: &Client,
    method: ReviewMethod,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    let url = review_request(method, path)?;
    let Some(token) = access_token(client)? else {
        bail!("Sign in to Lyssna in Settings to review lyrics");
    };
    let ttml = url.path().ends_with("/ttml");
    let request = match method {
        ReviewMethod::Get => client.get(url),
        ReviewMethod::Post => client
            .post(url)
            .json(&body.unwrap_or_else(|| serde_json::json!({}))),
    };
    let response = keyed(request)
        .bearer_auth(token)
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        if rejected.code.as_deref() == Some("forbidden") {
            bail!("Your Lyssna account can't review lyrics");
        }
        return Err(rejected.into_error());
    }
    if ttml {
        return Ok(serde_json::Value::String(response.text()?));
    }
    Ok(response.json()?)
}

/// A reviewer's decision that a song's recordings are instrumental (`true`),
/// have vocals (`false`), or go back to undecided (`None`). Lyssna then
/// answers lookups of those ISRCs with its decision.
pub fn set_instrumental(
    client: &Client,
    isrcs: &[String],
    instrumental: Option<bool>,
) -> Result<serde_json::Value> {
    ensure!(!isrcs.is_empty(), "Spotify has no ISRC for this song");
    let Some(token) = access_token(client)? else {
        bail!("Sign in to Lyssna in Settings to mark songs instrumental");
    };
    let response = keyed(client.put(format!("{API}/v1/instrumental")))
        .bearer_auth(token)
        .json(&instrumental_body(isrcs, instrumental))
        .send()
        .context("Cannot reach Lyssna")?;
    if !response.status().is_success() {
        let rejected = rejection(response);
        if rejected.code.as_deref() == Some("forbidden") {
            bail!("Only Trusted Lyssna members and up can mark songs instrumental");
        }
        return Err(rejected.into_error());
    }
    Ok(response.json()?)
}

fn instrumental_body(isrcs: &[String], instrumental: Option<bool>) -> serde_json::Value {
    serde_json::json!({ "instrumental": instrumental, "isrcs": isrcs })
}

/// The account an admin uploads as for a while. Kept in memory only, so it
/// ends with the app, on sign-out or after four hours; the API honours it
/// only for admins.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ActAs {
    pub id: String,
    pub username: String,
    /// When it ends, Unix milliseconds.
    pub until: i64,
}

const ACT_AS_FOR: Duration = Duration::from_secs(4 * 60 * 60);
static ACT_AS: Mutex<Option<(ActAs, Instant)>> = Mutex::new(None);

pub fn act_as() -> Option<ActAs> {
    let mut chosen = ACT_AS.lock().unwrap_or_else(|error| error.into_inner());
    match chosen.as_ref() {
        Some((_, ends)) if Instant::now() >= *ends => {
            *chosen = None;
            None
        }
        other => other.map(|(act, _)| act.clone()),
    }
}

pub fn set_act_as(id: &str, username: &str) -> Result<ActAs> {
    ensure!(is_user_id(id), "Not a Lyssna user ID");
    let until = OffsetDateTime::now_utc() + ACT_AS_FOR;
    let act = ActAs {
        id: id.to_ascii_lowercase(),
        username: username.trim().to_owned(),
        until: (until.unix_timestamp_nanos() / 1_000_000) as i64,
    };
    *ACT_AS.lock().unwrap_or_else(|error| error.into_inner()) =
        Some((act.clone(), Instant::now() + ACT_AS_FOR));
    Ok(act)
}

pub fn clear_act_as() {
    *ACT_AS.lock().unwrap_or_else(|error| error.into_inner()) = None;
}

fn is_user_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(at, c)| match at {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// The upload path, naming the chosen account when an admin uploads as one.
fn submissions_path(act: Option<&ActAs>) -> String {
    match act {
        Some(act) => format!("/v1/submissions?as={}", act.id),
        None => "/v1/submissions".to_owned(),
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ActAsMatch {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub reserved: bool,
}

/// Accounts an admin may upload as: by part of the name or a user ID,
/// reserved accounts first.
pub fn find_act_as(client: &Client, query: &str) -> Result<Vec<ActAsMatch>> {
    let Some(token) = access_token(client)? else {
        bail!("Sign in to Lyssna first");
    };
    let response = keyed(client.get(format!("{API}/v1/users/act-as")))
        .query(&[("limit", "8"), ("q", query.trim())])
        .bearer_auth(token)
        .send()
        .context("Cannot reach Lyssna")?;
    if response.status() == StatusCode::FORBIDDEN {
        bail!("Only admins can upload as another account");
    }
    if !response.status().is_success() {
        return Err(rejection(response).into_error());
    }
    Ok(response.json()?)
}

pub fn signed_in() -> bool {
    matches!(load(), Ok(Some(_)))
}

pub fn sign_out(client: &Client) -> Result<()> {
    clear_act_as();
    let _guard = TOKENS.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(tokens) = load()? {
        // Best effort: the server session also expires on its own.
        let _ = keyed(client.post(format!("{API}/v1/auth/logout")))
            .bearer_auth(&tokens.access_token)
            .json(&serde_json::json!({}))
            .send();
    }
    forget()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploads_go_to_the_chosen_account_until_cleared() {
        assert!(set_act_as("not-an-id", "Someone").is_err());
        let act = set_act_as("0B1C2D3E-4F50-6172-8394-A5B6C7D8E9F0", " Reserved ").unwrap();
        assert_eq!(act.id, "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0");
        assert_eq!(act.username, "Reserved");
        assert_eq!(act_as(), Some(act.clone()));
        assert_eq!(
            submissions_path(Some(&act)),
            "/v1/submissions?as=0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
        );
        clear_act_as();
        assert_eq!(act_as(), None);
        assert_eq!(submissions_path(None), "/v1/submissions");
    }

    #[test]
    fn review_requests_stay_on_the_review_routes() {
        let id = "0b9f6c1e-8a51-4e8f-9a52-3a1f0d6e2c44";
        let ok = |method, path: &str| review_request(method, path).is_ok();
        assert!(ok(ReviewMethod::Get, "/v1/queue?lane=priority&limit=50"));
        assert!(ok(ReviewMethod::Get, &format!("/v1/submissions/{id}")));
        assert!(ok(ReviewMethod::Get, &format!("/v1/revisions/{id}/ttml")));
        assert!(ok(
            ReviewMethod::Post,
            &format!("/v1/submissions/{id}/approve")
        ));
        assert!(ok(
            ReviewMethod::Post,
            &format!("/v1/submissions/{id}/request-changes")
        ));
        assert!(ok(
            ReviewMethod::Post,
            &format!("/v1/submissions/{id}/comments")
        ));
        assert!(!ok(ReviewMethod::Get, "/v1/queue?lane=links"));
        assert!(!ok(ReviewMethod::Get, "/v1/queue?limit=5000"));
        assert!(!ok(ReviewMethod::Get, "/v1/me"));
        assert!(!ok(
            ReviewMethod::Post,
            &format!("/v1/submissions/{id}/withdraw")
        ));
        assert!(!ok(ReviewMethod::Post, &format!("/v1/songs/{id}/revert")));
        assert!(!ok(ReviewMethod::Get, "/v1/submissions/../me"));
        assert!(!ok(ReviewMethod::Get, &format!("/v1/submissions/{id}?x=1")));
        assert!(!ok(ReviewMethod::Get, "//evil.example/v1/queue"));
        assert!(!ok(ReviewMethod::Get, "@evil.example/v1/queue"));
    }

    #[test]
    fn sign_in_url_carries_the_desktop_request() {
        let url = sign_in_url("proj1", "http://127.0.0.1:5000/cb", "verifier", "state").unwrap();
        assert_eq!(url.host_str(), Some("lyssna.org"));
        assert_eq!(url.path(), "/authorize");
        let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(query.contains(&("client_id".into(), "proj1".into())));
        assert!(query.contains(&("redirect_uri".into(), "http://127.0.0.1:5000/cb".into())));
        assert!(query.contains(&("code_challenge".into(), challenge("verifier"))));
        assert!(query.contains(&("code_challenge_method".into(), "S256".into())));
        assert!(query.contains(&("state".into(), "state".into())));
        assert!(
            !query
                .iter()
                .any(|(key, _)| key == "client" || key == "scope")
        );
    }

    #[test]
    fn callback_requires_matching_state_and_path() {
        assert_eq!(callback_code("/cb?code=abc&state=s1", "s1").unwrap(), "abc");
        assert!(callback_code("/cb?code=abc&state=other", "s1").is_err());
        assert!(callback_code("/other?code=abc&state=s1", "s1").is_err());
        assert!(callback_code("/cb?code=abc&code=def&state=s1", "s1").is_err());
        assert!(callback_code("/cb?state=s1", "s1").is_err());
        assert!(callback_code("/cb?code=&state=s1", "s1").is_err());
    }

    #[test]
    fn token_expiry_reads_go_timestamps() {
        let tokens: Tokens = TokenPair {
            access_token: "a".into(),
            access_expires_at: "2026-11-18T10:00:00.123456789Z".into(),
            refresh_token: "r".into(),
            refresh_expires_at: "2026-12-18T10:00:00+01:00".into(),
        }
        .try_into()
        .unwrap();
        assert_eq!(
            tokens.refresh_expires_at - tokens.access_expires_at,
            30 * 86_400 - 3_600
        );
    }

    #[test]
    fn me_reads_the_username() {
        let me: MeResponse = serde_json::from_str(
            r#"{"user":{"id":"u1","username":"Arashii","role":"admin","reputation":5,
                "email_verified":true,"avatar_source":"discord"},"tier":{"level":0,"name":"New"}}"#,
        )
        .unwrap();
        assert_eq!(me.user.username, "Arashii");
        assert_eq!(me.tier.name, "New");
    }

    #[test]
    fn submission_links_the_isrc_first_then_spotify_and_names_it() {
        let track = Track {
            id: Some("4cOdK2wGLETKBW3PvgPWqT".into()),
            name: "Uprising".into(),
            artists: vec![crate::model::Artist {
                name: "Muse".into(),
                ..Default::default()
            }],
            ..Track::default()
        };
        let body = submission_body(
            Some("<tt/>"),
            &track,
            &["GBAHT0600097".into(), "GBAHT0600098".into()],
            None,
        )
        .unwrap();
        assert_eq!(body["links"][0]["platform"], "isrc");
        assert_eq!(body["links"][0]["external_id"], "GBAHT0600097");
        assert_eq!(body["links"][1]["platform"], "spotify");
        assert_eq!(body["links"][1]["external_id"], "4cOdK2wGLETKBW3PvgPWqT");
        let without = submission_body(Some("<tt/>"), &track, &[], None).unwrap();
        assert_eq!(without["links"][0]["platform"], "spotify");
        assert_eq!(without["links"].as_array().unwrap().len(), 1);
        assert!(without.get("extra_isrcs").is_none());
        assert_eq!(
            body["extra_isrcs"],
            serde_json::json!(["GBAHT0600097", "GBAHT0600098"])
        );
        assert_eq!(body["title"], "Uprising");
        assert_eq!(body["artists"][0], "Muse");
        assert!(body.get("album").is_none());

        let local = Track {
            is_local: true,
            ..track
        };
        assert!(submission_body(Some("<tt/>"), &local, &[], None).is_err());
    }

    #[test]
    fn the_key_header_is_sent_only_when_there_is_a_key() {
        let client = Client::new();
        let with = with_key(client.get("https://api.lyssna.org/v1/me"), "pk_test")
            .build()
            .unwrap();
        assert_eq!(with.headers()["Lyssna-Key"], "pk_test");
        let without = with_key(client.get("https://api.lyssna.org/v1/me"), "")
            .build()
            .unwrap();
        assert!(without.headers().get("Lyssna-Key").is_none());
    }

    #[test]
    fn authored_at_keeps_only_dates_the_api_accepts() {
        let now = OffsetDateTime::parse("2026-11-19T12:00:00Z", &Rfc3339).unwrap();
        assert_eq!(
            authored_at("2026-05-01T10:00:00+02:00", now).as_deref(),
            Some("2026-05-01T08:00:00Z")
        );
        assert_eq!(
            authored_at("2015-01-01T00:00:00Z", now).as_deref(),
            Some("2015-01-01T00:00:00Z")
        );
        assert!(authored_at("2014-12-31T23:59:59Z", now).is_none());
        assert!(authored_at("1970-01-01T00:00:00Z", now).is_none());
        assert!(authored_at("2026-11-20T00:00:00Z", now).is_none());
        assert!(authored_at("2026-11-19T11:59:30Z", now).is_none());
        assert!(authored_at("2026-11-19T11:58:00Z", now).is_some());
        assert!(authored_at("yesterday", now).is_none());
    }

    #[test]
    fn instrumental_marks_name_every_isrc_and_can_be_taken_back() {
        let isrcs = vec!["USUM71900001".to_owned(), "GBUM71900002".to_owned()];
        assert_eq!(
            instrumental_body(&isrcs, Some(true)),
            serde_json::json!({"instrumental": true, "isrcs": ["USUM71900001", "GBUM71900002"]})
        );
        assert_eq!(
            instrumental_body(&isrcs, None)["instrumental"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn a_song_without_lyrics_is_submitted_as_instrumental_with_its_isrcs() {
        let track = Track {
            id: Some("4cOdK2wGLETKBW3PvgPWqT".into()),
            name: "Theme".into(),
            ..Track::default()
        };
        let body = submission_body(None, &track, &["GBAHT0600097".into()], None).unwrap();
        assert_eq!(body["instrumental"], true);
        assert!(body.get("ttml").is_none());
        assert_eq!(body["extra_isrcs"][0], "GBAHT0600097");
        assert!(submission_body(None, &track, &[], None).is_err());
    }

    #[test]
    fn submission_carries_a_valid_authored_date_only() {
        let track = Track {
            id: Some("4cOdK2wGLETKBW3PvgPWqT".into()),
            ..Track::default()
        };
        let body =
            submission_body(Some("<tt/>"), &track, &[], Some("2024-03-01T09:30:00.000Z")).unwrap();
        assert_eq!(body["authored_at"], "2024-03-01T09:30:00Z");
        let early =
            submission_body(Some("<tt/>"), &track, &[], Some("2001-01-01T00:00:00Z")).unwrap();
        assert!(early.get("authored_at").is_none());
        let none = submission_body(Some("<tt/>"), &track, &[], None).unwrap();
        assert!(none.get("authored_at").is_none());
    }

    #[test]
    fn api_errors_get_plain_wording() {
        let forbidden = StatusCode::FORBIDDEN;
        for code in [
            "token_app_mismatch",
            "insufficient_scope",
            "app_suspended",
            "blocked",
        ] {
            assert!(friendly(forbidden, Some(code), None).is_some(), "{code}");
        }
        assert!(friendly(StatusCode::UNAUTHORIZED, Some("invalid_key"), None).is_some());
        assert!(friendly(forbidden, Some("something_else"), None).is_none());
        assert!(friendly(forbidden, None, None).is_none());
        assert_eq!(
            friendly(StatusCode::TOO_MANY_REQUESTS, None, Some("12")).as_deref(),
            Some("Lyssna is busy. Try again in 12 seconds")
        );
        assert_eq!(
            friendly(StatusCode::TOO_MANY_REQUESTS, None, Some("soon")).as_deref(),
            Some("Lyssna is busy. Try again in a moment")
        );
    }

    #[test]
    fn submission_reads_what_lyssna_made_of_it() {
        let submission: Submission = serde_json::from_str(
            r#"{"id":"s1","song_id":"x","song_title":"Uprising","kind":"new","status":"pending","priority":false}"#,
        )
        .unwrap();
        assert_eq!(submission.status, "pending");
        assert_eq!(submission.kind, "new");
    }

    #[test]
    fn an_apple_credit_lyssna_refuses_comes_off_the_submission() {
        let refused = |code: &str| Rejection {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            retry_after: None,
            code: Some(code.into()),
            message: None,
        };
        let mut body = serde_json::json!({"ttml": "<tt/>", "apple_original": {"apple_id": "1"}});
        assert!(drops_apple_credit(
            &refused("apple_not_word_synced"),
            &mut body
        ));
        assert!(body.get("apple_original").is_none());
        assert!(!drops_apple_credit(
            &refused("apple_not_word_synced"),
            &mut body
        ));
        let mut other = serde_json::json!({"apple_original": {}});
        assert!(!drops_apple_credit(&refused("no_changes"), &mut other));
        assert!(other.get("apple_original").is_some());
    }
}
