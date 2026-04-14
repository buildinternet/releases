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
  version "0.10.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-arm64.gz"
      sha256 "2e6c86ef20730f5aa9a4ae719f737cf955c27b610d20ae9f1eb75398974ccbfd"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-x64.gz"
      sha256 "cc6e4bb8d8acfc8768b4c302027081de69726bec43f011bb39db3033d23cdd79"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-arm64.gz"
      sha256 "8376338c61f0bf2af3e3db5ee6d12e10b597c17feb01e08abc5b3db2696d4ba8"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-x64.gz"
      sha256 "abbae8fc3bd3704084be551977849b9b36e8b560693cf615225c7ba427d659d1"
    end
  end

  def install
    bin.install "releases"
  end

  test do
    assert_match "releases", shell_output("#{bin}/releases --version")
  end
end
