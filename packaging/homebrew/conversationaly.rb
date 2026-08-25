# Homebrew cask for Conversationaly.
#
# This file is the source of truth; Homebrew reads it from a tap repository,
# which must be named "homebrew-<something>". One-time setup:
#
#   gh repo create bykof/homebrew-tap --public --clone
#   mkdir -p homebrew-tap/Casks
#   cp packaging/homebrew/conversationaly.rb homebrew-tap/Casks/
#   cd homebrew-tap && git add -A && git commit -m "Add conversationaly cask" && git push
#
# On every release, bump `version` and `sha256` (take the hash from the
# SHA256SUMS asset) and push the tap again. Users then install with:
#
#   brew install --cask --no-quarantine bykof/tap/conversationaly
#
# --no-quarantine is what lets an unsigned app open without the Gatekeeper
# detour. Drop it from the instructions once the app is signed and notarized.

cask "conversationaly" do
  version "1.3.0"
  sha256 "5e524385de6fd1868ae42dbfd4803c8fd73ee1bb809cd5cd1009b3ed57f25b03"

  url "https://github.com/bykof/conversationaly/releases/download/v#{version}/conversationaly_#{version}_aarch64.dmg",
      verified: "github.com/bykof/conversationaly/"
  name "Conversationaly"
  desc "Privacy-first meeting assistant that transcribes and summarizes locally"
  homepage "https://github.com/bykof/conversationaly"

  # Only an aarch64 DMG is published, and system audio capture needs
  # ScreenCaptureKit.
  depends_on arch: :arm64
  depends_on macos: ">= :ventura"

  app "conversationaly.app"

  # ~/Movies/conversationaly-recordings is deliberately absent: those are the
  # user's own meeting recordings, not app state, and zap must not delete them.
  zap trash: [
    "~/Library/Application Support/com.conversationaly.ai",
    "~/Library/Application Support/Conversationaly",
    "~/Library/Caches/com.conversationaly.ai",
    "~/Library/HTTPStorages/com.conversationaly.ai",
    "~/Library/Preferences/com.conversationaly.ai.plist",
    "~/Library/Saved Application State/com.conversationaly.ai.savedState",
    "~/Library/WebKit/com.conversationaly.ai",
  ]
end
