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
  version "0.9.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-arm64.gz"
      sha256 "PLACEHOLDER_DARWIN_ARM64_SHA256"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-x64.gz"
      sha256 "PLACEHOLDER_DARWIN_X64_SHA256"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-arm64.gz"
      sha256 "PLACEHOLDER_LINUX_ARM64_SHA256"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-x64.gz"
      sha256 "PLACEHOLDER_LINUX_X64_SHA256"
    end
  end

  def install
    bin.install "releases"
  end

  test do
    assert_match "releases", shell_output("#{bin}/releases --version")
  end
end
