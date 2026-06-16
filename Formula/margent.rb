class Margent < Formula
  desc "Local-first Markdown review CLI for anchored threads and agent proposals"
  homepage "https://github.com/Brehove/margent"
  url "https://github.com/Brehove/margent.git", branch: "main"
  version "0.1.0"
  license "MIT"

  depends_on "rust" => :build

  def install
    cd "cli" do
      system "cargo", "install", "--locked", "--path", ".", "--root", prefix
    end
  end

  test do
    assert_match "Margent", shell_output("#{bin}/margent doctor")
  end
end

