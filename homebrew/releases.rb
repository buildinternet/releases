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
  version "0.11.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-arm64.gz"
      sha256 "8743978f59043823b94394665f77f4b3a89d4f40ffcc54a631775d7a036ed6e1"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-darwin-x64.gz"
      sha256 "c6896548005ffd4d1f4dd3c0dde7748ee186cf4b8fad992f8829bfd552869ff5"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-arm64.gz"
      sha256 "eda9945816af1a2a7b9f72069052777223900d9b5f51080b4fba98ee6b6b9e79"
    else
      url "https://github.com/zachdunn/releases/releases/download/v#{version}/releases-linux-x64.gz"
      sha256 "c6c6abf4c5b6655758994543dd51368b07000fed3923fce6de931825315e6878"
    end
  end

  def install
    bin.install "releases"
  end

  test do
    assert_match "releases", shell_output("#{bin}/releases --version")
  end
end
