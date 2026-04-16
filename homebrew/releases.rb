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
  version "0.11.1"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-arm64.gz"
      sha256 "78d3e594b5d25519525a065b80f5b10a68b5a98c6f75b21241b3f57443601c04"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-x64.gz"
      sha256 "e9e046c39dc9113fca39a10a6bc8814a28c954d1e2e7afa17100f6ba433d0a89"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-arm64.gz"
      sha256 "1cbf6e7562dc273d9f28ca2b4ee24290ccbd9283e88f6c0500e070e9321d7745"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-x64.gz"
      sha256 "ca7346519be8e283928a0d5557fab00df8b50ed2ec4af0f8082c3f33846abc3e"
    end
  end

  def install
    bin.install "releases"
  end

  test do
    assert_match "releases", shell_output("#{bin}/releases --version")
  end
end
