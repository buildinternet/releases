## 9.1.0

- Added OAuth device-flow support for headless logins.
- Added a `--json` output mode to the `status` command.
- Patched a path-traversal vulnerability in the file-upload handler that allowed
  a crafted filename to write outside the configured upload directory.
- Improved startup time by lazy-loading the plugin registry.
