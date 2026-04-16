# Homebrew formula for the Released CLI
# Tap: buildinternet/tap
#
# To use:
#   brew tap buildinternet/tap
#   brew install releases
#
# This formula downloads prebuilt binaries from GitHub Releases.
# Version and SHA256 hashes are updated automatically by CI.

class Releases < Formula
  desc "Changelog indexer and registry for AI agents and developers"
  homepage "https://releases.sh"
  version "0.12.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-arm64.gz"
      sha256 "f79f31af76fe3a42c2749288037a6c93b025f0c194eb2a4072410e2eb334e457"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-x64.gz"
      sha256 "cfef96e6f30fb31ed08816baa1f87f81a44453265e1b367afcab66145750d406"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-arm64.gz"
      sha256 "9912d0625c12e8ab5427effec2e68da44b3d9838f220a2b940e0fc2127e70028"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-x64.gz"
      sha256 "17077a8d20cce5381d769ba5e9b85189070de447607ae6f2a7e6aede3dbbe899"
    end
  end

  def install
    bin.install "releases"
  end

  test do
    assert_match "releases", shell_output("#{bin}/releases --version")
  end
end
