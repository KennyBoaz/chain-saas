/**
 * The two ways to connect WhatsApp. This is the single source of truth: the "choose" and "requirements"
 * pages both render from it (GET /api/whatsapp/modes), so the wording is edited in one place only.
 */
const COMMON_DECISIONS = [
  "You sign in with Facebook and choose the business portfolio and WhatsApp account to connect.",
  "You give Chain permission to send and receive WhatsApp messages and to manage message templates for that account.",
  "Chain stores an access token (encrypted) and your customers' messages in your account, as described in our Privacy Policy.",
  "As soon as the connection finishes, the AI assistant starts answering customers on this number. Set your opening hours and assistant prompt in Settings first if you want it ready.",
];

const MODES = [
  {
    id: "coexistence",
    name: "Keep my WhatsApp Business app",
    tagline: "Use the WhatsApp Business app on your phone and the Chain assistant on the same number.",
    bestFor: "Businesses already chatting with customers in the WhatsApp Business app who want to keep doing so.",
    features: [
      "The same number works in the app on your phone and in Chain.",
      "Your team can still reply from the phone. Those replies show in the Chain inbox, and the assistant pauses in that chat.",
      "You can choose to bring your chat history and contacts across.",
      "Customers notice no change: same number, same chats.",
    ],
    requirements: [
      { id: "bizapp", text: "The number is already active in the WhatsApp Business app, not the regular WhatsApp app.", hint: "The green app with a B. If you use regular WhatsApp, switch to the Business app first." },
      { id: "version", text: "The Business app is version 2.24.17 or newer.", hint: "Update it in your phone's app store." },
      { id: "phone", text: "You have that phone in your hand now and can scan a QR code with it.", hint: "Meta asks you to scan a code from the Business app to link it." },
      { id: "fb", text: "You can sign in to the Facebook account that manages your business, as an admin.", hint: "Meta needs an admin of the business portfolio to approve the connection." },
      { id: "keep", text: "You will keep the app installed and open it at least every 13 days.", hint: "Meta currently disconnects numbers whose app has not been opened for too long. Check Meta's coexistence page for the latest rule." },
    ],
    pros: ["Nothing changes for your team or customers", "Keep using the phone app you know", "Chat history can come across", "Easy to try and to undo"],
    cons: ["Some Business app features are limited or switched off on a connected number", "The phone and app must stay active", "One number per connection", "Not available in every country: Meta tells you during sign-up if yours is not eligible"],
    decisions: COMMON_DECISIONS.concat([
      "You decide in Meta's screens whether to share your existing chat history and contacts.",
      "From now on, a reply you send from the phone pauses the assistant in that chat until you hand it back in Chain.",
    ]),
    steps: ["A Meta window opens and you sign in with Facebook.", "You choose your business and confirm the number from the Business app.", "You scan the QR code with your phone and approve sharing.", "Chain finishes the setup in a few seconds.", "You send a test message to your number from another phone."],
  },
  {
    id: "api",
    name: "API only",
    tagline: "Run the number entirely through Chain. No phone app needed.",
    bestFor: "New numbers, higher message volumes, or teams that want everyone working in the Chain inbox.",
    features: [
      "All replies, from the assistant and your team, go through Chain.",
      "Works without a phone: no app to keep open, no phone to keep charged.",
      "Suits a brand-new number, a landline or a virtual number that can receive a verification call or SMS.",
      "Built for volume and for several team members sharing one inbox.",
    ],
    requirements: [
      { id: "free", text: "The number is not in use on WhatsApp or the WhatsApp Business app, or you accept that connecting will remove it from there.", hint: "A number can live in only one place. Once it is on the API it can no longer be used in the apps." },
      { id: "verify", text: "You can receive a verification code by SMS or phone call on this number during setup.", hint: "Meta sends a one-time code to confirm you own the number." },
      { id: "fb", text: "You can sign in to the Facebook account that manages your business, as an admin.", hint: "Meta needs an admin of the business portfolio to approve the connection." },
      { id: "name", text: "You have the business name ready, matching your website or documents.", hint: "Meta reviews the name customers will see on this number." },
      { id: "history", text: "You are fine with old chats on a phone not being carried over.", hint: "API-only starts a fresh history in Chain." },
    ],
    pros: ["Clean and stable, with no dependence on a phone", "Best for high volume and bigger teams", "Works with landline and virtual numbers", "Full control from Chain"],
    cons: ["The number can no longer be used in WhatsApp or the Business app", "Earlier chats on a phone are not imported", "Your team must reply from Chain, not from a phone", "Switching back later means re-registering the number"],
    decisions: COMMON_DECISIONS.concat([
      "Connecting moves this number onto the WhatsApp Business API. It will stop working in the WhatsApp and WhatsApp Business apps.",
      "Chain sets a two-step verification PIN on the number and keeps it securely (encrypted), so you do not need to remember it.",
    ]),
    steps: ["A Meta window opens and you sign in with Facebook.", "You choose your business and enter the number.", "Meta sends a code by SMS or call and you enter it.", "Chain registers the number and finishes the setup in a few seconds.", "You send a test message to your number from another phone."],
  },
];

module.exports = { MODES, byId: (id) => MODES.find((m) => m.id === id) || null };