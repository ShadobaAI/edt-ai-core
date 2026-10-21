# Copyright and license

Copyright (c) 2026 ShadobaAI and contributors.

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.

The original code, skills and documentation of 1C AI Core are distributed
under MPL 2.0. See [LICENSE](LICENSE) for the full terms.
Third-party material retains its applicable copyright notices and licenses.

Bundled Node dependencies (YAML, Ajv and its dependencies, fflate, Koffi) retain
their MIT licenses and author notices in `vendor/NOTICE.txt`. Koffi's prebuilt
Windows N-API addons are included for x64 and arm64; no compiler or install script
runs on the user's machine. Source: https://github.com/Koromix/koffi.
The bundle is reproducible from package-lock.json and tools/vendor.mjs.
Unicode 15.0 case-folding data preserves pre-migration state keys; its license
and copyright are in UNICODE-LICENSE.txt. Source: https://www.unicode.org/.
External Java/BSL LS, code-index and user-started MCP components retain their
own licenses and are not embedded in the plugin archive.
