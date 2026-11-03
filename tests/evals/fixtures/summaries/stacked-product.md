## 4.16.2

### Bug Fixes

- Remote configuration: updating or deleting one remote configuration for a service no longer discards tracing settings (sampling rules, tags, log injection) applied by other remote configurations that still target it.
- falcon: fixed `falcon.asgi.App` creation failing when the falcon integration is enabled.
- Symbol Database: fixed an `AttributeError` raised on Python versions earlier than 3.9.8.
