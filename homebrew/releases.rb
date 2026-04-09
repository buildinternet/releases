# Homebrew formula for the Released CLI
# Tap: buildinternet/tap
#
# To use:
#   brew tap buildinternet/tap
#   brew install releases
#
# This formula downloads prebuilt binaries from the npm registry.
# Update the version and sha256 hashes when publishing a new release.

class Releases < Formula
  desc "Changelog indexer and registry for AI agents and developers"
  homepage "https://releases.sh"
  version "0.9.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://registry.npmjs.org/@buildinternet/releases-darwin-arm64/-/releases-darwin-arm64-#{version}.tgz"
      sha256 "PLACEHOLDER_DARWIN_ARM64_SHA256"
    else
      url "https://registry.npmjs.org/@buildinternet/releases-darwin-x64/-/releases-darwin-x64-#{version}.tgz"
      sha256 "PLACEHOLDER_DARWIN_X64_SHA256"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://registry.npmjs.org/@buildinternet/releases-linux-arm64/-/releases-linux-arm64-#{version}.tgz"
      sha256 "PLACEHOLDER_LINUX_ARM64_SHA256"
    else
      url "https://registry.npmjs.org/@buildinternet/releases-linux-x64/-/releases-linux-x64-#{version}.tgz"
      sha256 "PLACEHOLDER_LINUX_X64_SHA256"
    end
  end

  def install
    bin.install "package/releases"
  end

  test do
    assert_match "releases", shell_output("#{bin}/releases --version")
  end
end
