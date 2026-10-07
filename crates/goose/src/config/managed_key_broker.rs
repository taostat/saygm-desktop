use std::sync::atomic::AtomicBool;

const ACTIVATION_ENV: &str = "SAYGM_MANAGED_KEY_BROKER";
#[cfg(target_os = "macos")]
const ACTIVATION_VALUE: &str = "fd3-v1";
#[cfg(target_os = "macos")]
const SAYGM_DESKTOP_ENV: &str = "SAYGM_DESKTOP";

static ACTIVATION_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
mod unix {
    use super::{ACTIVATION_ENV, ACTIVATION_REQUESTED};
    #[cfg(target_os = "macos")]
    use super::{ACTIVATION_VALUE, SAYGM_DESKTOP_ENV};
    use serde_json::{json, Value};
    #[cfg(test)]
    use std::cell::RefCell;
    use std::env;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    #[cfg(any(target_os = "macos", test))]
    use std::os::fd::FromRawFd;
    #[cfg(test)]
    use std::os::fd::IntoRawFd;
    #[cfg(test)]
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::Ordering;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    const BROKER_FD: i32 = 3;
    const MAX_FRAME_BYTES: usize = 16 * 1024;
    const MAX_KEY_BYTES: usize = 4 * 1024;
    #[cfg(target_os = "macos")]
    const BROKER_TIMEOUT: Duration = Duration::from_secs(30);

    static BROKER: OnceLock<BrokerClient> = OnceLock::new();

    #[cfg(test)]
    thread_local! {
        static TEST_BROKER: RefCell<Option<BrokerClient>> = const { RefCell::new(None) };
    }

    struct BrokerClient {
        state: Mutex<BrokerState>,
        timeout: Duration,
    }

    struct BrokerState {
        stream: Option<File>,
        next_id: u64,
    }

    #[derive(Debug, thiserror::Error)]
    #[error("managed key broker {code}")]
    pub(super) struct BrokerError {
        code: &'static str,
        retire: bool,
    }

    impl BrokerError {
        fn new(code: &'static str) -> Self {
            Self {
                code,
                retire: matches!(code, "unavailable" | "invalid_response"),
            }
        }

        fn retryable(code: &'static str) -> Self {
            Self {
                code,
                retire: false,
            }
        }
    }

    impl BrokerClient {
        fn new(stream: File, timeout: Duration) -> Self {
            Self {
                state: Mutex::new(BrokerState {
                    stream: Some(stream),
                    next_id: 1,
                }),
                timeout,
            }
        }

        fn get_model_key(&self) -> Result<Option<String>, BrokerError> {
            self.exchange(
                |id| json!({ "id": id, "op": "get_model_key" }),
                |id, response| {
                    let object = response_object(&response)?;
                    validate_common_response(object, id)?;
                    if object.get("ok") == Some(&Value::Bool(false)) {
                        return Err(broker_failure(object)?);
                    }
                    if object.len() != 3 || object.get("ok") != Some(&Value::Bool(true)) {
                        return Err(BrokerError::new("invalid_response"));
                    }
                    let key = object
                        .get("key")
                        .ok_or(BrokerError::new("invalid_response"))?;
                    match key {
                        Value::Null => Ok(None),
                        Value::String(key) if key.len() <= MAX_KEY_BYTES => Ok(Some(key.clone())),
                        _ => Err(BrokerError::new("invalid_response")),
                    }
                },
            )
        }

        fn model_key_matches(&self, sha256: &str) -> Result<bool, BrokerError> {
            if !valid_sha256(sha256) {
                return Err(BrokerError::new("invalid_request"));
            }
            self.exchange(
                |id| json!({ "id": id, "op": "model_key_matches", "sha256": sha256 }),
                |id, response| {
                    let object = response_object(&response)?;
                    validate_common_response(object, id)?;
                    if object.get("ok") == Some(&Value::Bool(false)) {
                        return Err(broker_failure(object)?);
                    }
                    if object.len() != 3 || object.get("ok") != Some(&Value::Bool(true)) {
                        return Err(BrokerError::new("invalid_response"));
                    }
                    object
                        .get("matches")
                        .and_then(Value::as_bool)
                        .ok_or(BrokerError::new("invalid_response"))
                },
            )
        }

        fn exchange<T>(
            &self,
            make_request: impl FnOnce(u64) -> Value,
            parse_response: impl FnOnce(u64, Value) -> Result<T, BrokerError>,
        ) -> Result<T, BrokerError> {
            let mut state = self
                .state
                .lock()
                .map_err(|_| BrokerError::new("unavailable"))?;
            let id = state.next_id;
            state.next_id = id.checked_add(1).ok_or(BrokerError::new("unavailable"))?;
            let Some(stream) = state.stream.as_mut() else {
                return Err(BrokerError::new("unavailable"));
            };
            let result = exchange_frame(stream, id, make_request(id), self.timeout)
                .and_then(|response| parse_response(id, response));
            if result.as_ref().is_err_and(|error| error.retire) {
                state.stream.take();
            }
            result
        }
    }

    fn exchange_frame(
        stream: &mut File,
        id: u64,
        request: Value,
        timeout: Duration,
    ) -> Result<Value, BrokerError> {
        let mut frame =
            serde_json::to_vec(&request).map_err(|_| BrokerError::new("invalid_request"))?;
        frame.push(b'\n');
        if frame.len() > MAX_FRAME_BYTES {
            return Err(BrokerError::new("invalid_request"));
        }
        let write_deadline = Instant::now() + timeout;
        let mut written = 0;
        while written < frame.len() {
            wait_for_descriptor(stream, libc::POLLOUT, write_deadline)?;
            let count = stream
                .write(&frame[written..])
                .map_err(|_| BrokerError::new("unavailable"))?;
            if count == 0 {
                return Err(BrokerError::new("unavailable"));
            }
            written += count;
        }

        let mut response = Vec::with_capacity(256);
        let read_deadline = Instant::now() + timeout;
        loop {
            wait_for_descriptor(stream, libc::POLLIN, read_deadline)?;
            let mut byte = [0_u8; 1];
            match stream.read(&mut byte) {
                Ok(0) => return Err(BrokerError::new("unavailable")),
                Ok(_) if byte[0] == b'\n' => break,
                Ok(_) => {
                    if response.len() + 1 >= MAX_FRAME_BYTES {
                        return Err(BrokerError::new("invalid_response"));
                    }
                    response.push(byte[0]);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    return Err(BrokerError::new("unavailable"));
                }
                Err(_) => return Err(BrokerError::new("unavailable")),
            }
        }

        let parsed: Value =
            serde_json::from_slice(&response).map_err(|_| BrokerError::new("invalid_response"))?;
        let object = response_object(&parsed)?;
        validate_common_response(object, id)?;
        Ok(parsed)
    }

    fn wait_for_descriptor(
        stream: &File,
        event: i16,
        deadline: Instant,
    ) -> Result<(), BrokerError> {
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or(BrokerError::new("unavailable"))?;
            let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
            let mut descriptor = libc::pollfd {
                fd: stream.as_raw_fd(),
                events: event,
                revents: 0,
            };
            let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
            if result == 0 {
                return Err(BrokerError::new("unavailable"));
            }
            if result < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(BrokerError::new("unavailable"));
            }
            if descriptor.revents & event != 0 {
                return Ok(());
            }
            return Err(BrokerError::new("unavailable"));
        }
    }

    fn response_object(value: &Value) -> Result<&serde_json::Map<String, Value>, BrokerError> {
        value
            .as_object()
            .ok_or(BrokerError::new("invalid_response"))
    }

    fn validate_common_response(
        object: &serde_json::Map<String, Value>,
        expected_id: u64,
    ) -> Result<(), BrokerError> {
        if object.get("id").and_then(Value::as_u64) != Some(expected_id) {
            return Err(BrokerError::new("invalid_response"));
        }
        if object.get("ok").and_then(Value::as_bool).is_none() {
            return Err(BrokerError::new("invalid_response"));
        }
        Ok(())
    }

    fn broker_failure(object: &serde_json::Map<String, Value>) -> Result<BrokerError, BrokerError> {
        if object.len() != 3 {
            return Err(BrokerError::new("invalid_response"));
        }
        match object.get("code").and_then(Value::as_str) {
            Some("unavailable") => Ok(BrokerError::retryable("unavailable")),
            Some("denied") => Ok(BrokerError::retryable("denied")),
            Some("revoked") => Ok(BrokerError::retryable("revoked")),
            Some("invalid_request") => Ok(BrokerError::retryable("invalid_request")),
            Some("internal_error") => Ok(BrokerError::retryable("internal_error")),
            _ => Err(BrokerError::new("invalid_response")),
        }
    }

    pub(super) fn requested() -> bool {
        ACTIVATION_REQUESTED.load(Ordering::Relaxed) || env::var_os(ACTIVATION_ENV).is_some() || {
            #[cfg(test)]
            {
                TEST_BROKER.with(|broker| broker.borrow().is_some())
            }
            #[cfg(not(test))]
            {
                false
            }
        }
    }

    pub(super) fn initialize() -> Result<(), String> {
        let activation = env::var_os(ACTIVATION_ENV);
        if activation.is_none() {
            #[cfg(target_os = "macos")]
            if env::var(SAYGM_DESKTOP_ENV).ok().as_deref() == Some("1") {
                set_fd_cloexec_if_open(BROKER_FD).map_err(|_| "could not secure inherited fd 3")?;
                return Err(
                    "managed key broker activation is required for SayGM on macOS".to_string(),
                );
            }
            return Ok(());
        }

        ACTIVATION_REQUESTED.store(true, Ordering::Relaxed);
        set_fd_cloexec_if_open(BROKER_FD).map_err(|_| "could not secure inherited fd 3")?;
        env::remove_var(ACTIVATION_ENV);

        #[cfg(not(target_os = "macos"))]
        return Err("managed key broker is supported only on macOS".to_string());

        #[cfg(target_os = "macos")]
        {
            if activation.as_deref() != Some(std::ffi::OsStr::new(ACTIVATION_VALUE)) {
                return Err("managed key broker activation is invalid".to_string());
            }
            if env::var(SAYGM_DESKTOP_ENV).ok().as_deref() != Some("1") {
                return Err("managed key broker requires the SayGM desktop product".to_string());
            }

            let descriptor_flags = unsafe { libc::fcntl(BROKER_FD, libc::F_GETFD) };
            if descriptor_flags < 0 {
                return Err("managed key broker descriptor is unavailable".to_string());
            }
            let status_flags = unsafe { libc::fcntl(BROKER_FD, libc::F_GETFL) };
            if status_flags < 0 || status_flags & libc::O_ACCMODE != libc::O_RDWR {
                return Err("managed key broker descriptor must be duplex".to_string());
            }
            let mut socket_type = 0;
            let mut socket_type_len = std::mem::size_of_val(&socket_type) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    BROKER_FD,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut socket_type as *mut i32).cast(),
                    &mut socket_type_len,
                )
            } < 0
                || socket_type != libc::SOCK_STREAM
            {
                return Err("managed key broker descriptor must be a stream socket".to_string());
            }
            let mut address: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
            let mut address_len = std::mem::size_of_val(&address) as libc::socklen_t;
            if unsafe {
                libc::getsockname(
                    BROKER_FD,
                    (&mut address as *mut libc::sockaddr_storage).cast(),
                    &mut address_len,
                )
            } < 0
                || address.ss_family != libc::AF_UNIX as libc::sa_family_t
            {
                return Err("managed key broker descriptor must be a local socket".to_string());
            }
            let stream = unsafe { File::from_raw_fd(BROKER_FD) };
            BROKER
                .set(BrokerClient::new(stream, BROKER_TIMEOUT))
                .map_err(|_| "managed key broker was initialized more than once")?;
            Ok(())
        }
    }

    fn set_fd_cloexec_if_open(fd: i32) -> Result<(), std::io::Error> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            if env::var_os(ACTIVATION_ENV).is_none() {
                return Ok(());
            }
            return Err(std::io::Error::last_os_error());
        }
        set_fd_cloexec(fd, flags)?;
        Ok(())
    }

    pub(super) fn set_fd_cloexec(fd: i32, flags: i32) -> Result<(), std::io::Error> {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn get_model_key() -> Result<Option<String>, String> {
        #[cfg(test)]
        if let Some(result) =
            TEST_BROKER.with(|broker| broker.borrow().as_ref().map(BrokerClient::get_model_key))
        {
            return result.map_err(|error| error.to_string());
        }
        BROKER
            .get()
            .ok_or_else(|| "unavailable".to_string())?
            .get_model_key()
            .map_err(|error| error.to_string())
    }

    pub(super) fn model_key_matches(sha256: &str) -> Result<bool, String> {
        #[cfg(test)]
        if let Some(result) = TEST_BROKER.with(|broker| {
            broker
                .borrow()
                .as_ref()
                .map(|client| client.model_key_matches(sha256))
        }) {
            return result.map_err(|error| error.to_string());
        }
        BROKER
            .get()
            .ok_or_else(|| "unavailable".to_string())?
            .model_key_matches(sha256)
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    fn client_for_test(stream: UnixStream, timeout: Duration) -> BrokerClient {
        let fd = stream.into_raw_fd();
        BrokerClient::new(unsafe { File::from_raw_fd(fd) }, timeout)
    }

    #[cfg(test)]
    pub(super) fn with_test_broker<T>(
        stream: UnixStream,
        timeout: Duration,
        operation: impl FnOnce() -> T,
    ) -> T {
        let previous =
            TEST_BROKER.with(|broker| broker.replace(Some(client_for_test(stream, timeout))));
        struct RestoreBroker(Option<BrokerClient>);
        impl Drop for RestoreBroker {
            fn drop(&mut self) {
                TEST_BROKER.with(|broker| {
                    broker.replace(self.0.take());
                });
            }
        }
        let restore = RestoreBroker(previous);
        let result = operation();
        drop(restore);
        result
    }

    fn valid_sha256(value: &str) -> bool {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    #[cfg(test)]
    mod tests {
        use super::{client_for_test, MAX_FRAME_BYTES};
        use serde_json::Value;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::os::unix::net::UnixStream;
        use std::thread;
        use std::time::Duration;

        #[test]
        fn fixture_exchanges_key_and_digest_without_keyring() {
            let (client_stream, server_stream) = UnixStream::pair().unwrap();
            let server = thread::spawn(move || {
                let mut reader = BufReader::new(server_stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap()["op"],
                    "get_model_key"
                );
                reader
                    .get_mut()
                    .write_all(b"{\"id\":1,\"ok\":true,\"key\":\"fixture-model-key\"}\n")
                    .unwrap();
                line.clear();
                reader.read_line(&mut line).unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&line).unwrap()["op"],
                    "model_key_matches"
                );
                reader
                    .get_mut()
                    .write_all(b"{\"id\":2,\"ok\":true,\"matches\":true}\n")
                    .unwrap();
            });
            let client = client_for_test(client_stream, Duration::from_secs(1));
            assert_eq!(
                client.get_model_key().unwrap().as_deref(),
                Some("fixture-model-key")
            );
            assert!(client.model_key_matches(&"a".repeat(64)).unwrap());
            server.join().unwrap();
        }

        #[test]
        fn timeout_latches_and_late_reply_cannot_desynchronize_stream() {
            let (client_stream, mut server_stream) = UnixStream::pair().unwrap();
            let server = thread::spawn(move || {
                let mut request = [0_u8; 256];
                let _ = server_stream.read(&mut request);
                thread::sleep(Duration::from_millis(120));
                let _ = server_stream.write_all(b"{\"id\":1,\"ok\":true,\"key\":null}\n");
            });
            let client = client_for_test(client_stream, Duration::from_millis(30));
            assert!(client.get_model_key().is_err());
            assert!(client.get_model_key().is_err());
            server.join().unwrap();
        }

        #[test]
        fn controlled_broker_failure_keeps_connection_available_for_retry() {
            let (client_stream, server_stream) = UnixStream::pair().unwrap();
            let server = thread::spawn(move || {
                let mut reader = BufReader::new(server_stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                reader
                    .get_mut()
                    .write_all(b"{\"id\":1,\"ok\":false,\"code\":\"unavailable\"}\n")
                    .unwrap();
                line.clear();
                reader.read_line(&mut line).unwrap();
                reader
                    .get_mut()
                    .write_all(b"{\"id\":2,\"ok\":true,\"key\":\"fixture-model-key\"}\n")
                    .unwrap();
            });
            let client = client_for_test(client_stream, Duration::from_secs(1));
            assert!(client.get_model_key().is_err());
            assert_eq!(
                client.get_model_key().unwrap().as_deref(),
                Some("fixture-model-key")
            );
            server.join().unwrap();
        }

        #[test]
        fn invalid_or_oversized_reply_retires_connection() {
            let (client_stream, mut server_stream) = UnixStream::pair().unwrap();
            let server = thread::spawn(move || {
                let mut request = [0_u8; 256];
                let _ = server_stream.read(&mut request);
                server_stream
                    .write_all(&vec![b'x'; MAX_FRAME_BYTES])
                    .unwrap();
            });
            let client = client_for_test(client_stream, Duration::from_secs(1));
            assert!(client.get_model_key().is_err());
            assert!(client.get_model_key().is_err());
            server.join().unwrap();
        }

        #[test]
        fn wrong_response_type_retires_connection() {
            let (client_stream, mut server_stream) = UnixStream::pair().unwrap();
            let server = thread::spawn(move || {
                let mut request = [0_u8; 256];
                let _ = server_stream.read(&mut request);
                server_stream
                    .write_all(b"{\"id\":1,\"ok\":true,\"key\":42}\n")
                    .unwrap();
                let _ = server_stream.read(&mut request);
                let _ = server_stream.write_all(b"{\"id\":2,\"ok\":true,\"key\":null}\n");
            });
            let client = client_for_test(client_stream, Duration::from_secs(1));
            assert!(client.get_model_key().is_err());
            assert!(client.get_model_key().is_err());
            server.join().unwrap();
        }

        #[test]
        fn concurrent_requests_keep_wire_ids_monotonic() {
            let (client_stream, server_stream) = UnixStream::pair().unwrap();
            let server = thread::spawn(move || {
                let mut reader = BufReader::new(server_stream);
                for expected_id in 1..=8 {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(request["id"], expected_id);
                    reader
                        .get_mut()
                        .write_all(
                            format!("{{\"id\":{expected_id},\"ok\":true,\"matches\":true}}\n")
                                .as_bytes(),
                        )
                        .unwrap();
                }
            });
            let client =
                std::sync::Arc::new(client_for_test(client_stream, Duration::from_secs(1)));
            let callers = (0..8)
                .map(|_| {
                    let client = std::sync::Arc::clone(&client);
                    thread::spawn(move || client.model_key_matches(&"a".repeat(64)).unwrap())
                })
                .collect::<Vec<_>>();
            for caller in callers {
                assert!(caller.join().unwrap());
            }
            server.join().unwrap();
        }
    }
}

#[cfg(not(unix))]
mod unix {
    use super::{ACTIVATION_ENV, ACTIVATION_REQUESTED};
    use std::env;
    use std::sync::atomic::Ordering;

    pub(super) fn requested() -> bool {
        ACTIVATION_REQUESTED.load(Ordering::Relaxed) || env::var_os(ACTIVATION_ENV).is_some()
    }

    pub(super) fn initialize() -> Result<(), String> {
        if env::var_os(ACTIVATION_ENV).is_some() {
            ACTIVATION_REQUESTED.store(true, Ordering::Relaxed);
            return Err("managed key broker is unavailable on this platform".to_string());
        }
        Ok(())
    }

    pub(super) fn get_model_key() -> Result<Option<String>, String> {
        Err("unavailable".to_string())
    }

    pub(super) fn model_key_matches(_sha256: &str) -> Result<bool, String> {
        Err("unavailable".to_string())
    }
}

pub fn initialize_managed_key_broker() -> Result<(), String> {
    unix::initialize()
}

pub(crate) fn is_requested() -> bool {
    unix::requested()
}

pub(crate) fn get_model_key() -> Result<Option<String>, String> {
    unix::get_model_key()
}

pub(crate) fn model_key_matches(sha256: &str) -> Result<bool, String> {
    unix::model_key_matches(sha256)
}

#[cfg(all(test, unix))]
pub(crate) fn with_test_broker<T>(
    stream: std::os::unix::net::UnixStream,
    timeout: std::time::Duration,
    operation: impl FnOnce() -> T,
) -> T {
    unix::with_test_broker(stream, timeout, operation)
}

#[cfg(all(test, unix))]
mod platform_tests {
    use std::os::unix::io::AsRawFd;
    use std::process::Command;

    #[cfg(unix)]
    #[test]
    fn cloexec_helper_sets_descriptor_flag() {
        let (reader, _writer) = std::os::unix::net::UnixStream::pair().unwrap();
        let fd = reader.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert!(flags >= 0);
        assert!(unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } >= 0);
        let child_can_read_fd = || {
            Command::new("sh")
                .arg("-c")
                .arg(format!("test -r /dev/fd/{fd}"))
                .status()
                .unwrap()
                .success()
        };
        assert!(child_can_read_fd());
        super::unix::set_fd_cloexec(fd, flags).unwrap();
        assert_ne!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert!(!child_can_read_fd());
    }
}
