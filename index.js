import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
} from "discord.js";
import { handleOrderCommand, handleInteraction } from "./order.js";

// ── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ── Per-channel conversation history ─────────────────────────────────────────
// Maps channelId → Anthropic.MessageParam[]
const histories = new Map();

const MAX_HISTORY = 20; // keep last N messages per channel

// ── Bot ready ────────────────────────────────────────────────────────────────
discord.once(Events.ClientReady, (client) => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Powered by Claude", { type: ActivityType.Custom });
});

// ── Message handler ───────────────────────────────────────────────────────────
discord.on(Events.MessageCreate, async (message) => {
  // Ignore other bots
  if (message.author.bot) return;

  // ── order command(any channel)────────────────────────────────────────
  if (message.content.trim() === "!點餐" || message.content.trim() === "!order") {
    await handleOrderCommand(message);
    return;
  }

  const isDM = !message.guild;
  const mentioned = message.mentions.has(discord.user);

  // Only respond when mentioned in a server, or in DMs
  if (!isDM && !mentioned) return;

  // Strip the @mention from the text
  const userText = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!userText) {
    await message.reply("Hey! Ask me anything.");
    return;
  }

  // Retrieve (or create) history for this channel/DM
  const channelId = message.channelId;
  if (!histories.has(channelId)) histories.set(channelId, []);
  const history = histories.get(channelId);

  // Append user turn
  history.push({ role: "user", content: userText });

  // Show typing indicator
  await message.channel.sendTyping();

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system:
        "You are a helpful, friendly assistant in a Discord server. " +
        "Keep responses concise (under 1800 characters when possible) " +
        "since Discord has a 2000-character message limit. " +
        "Use markdown formatting where it helps readability.",
      messages: history,
    });

    const assistantText =
      response.content.find((b) => b.type === "text")?.text ?? "(no response)";

    // Append assistant turn to history
    history.push({ role: "assistant", content: assistantText });

    // Trim history to avoid unbounded growth
    if (history.length > MAX_HISTORY * 2) {
      history.splice(0, 2); // remove oldest user+assistant pair
    }

    // Discord messages max out at 2000 chars — split if needed
    const chunks = splitMessage(assistantText);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error("Claude API error:", err);
    await message.reply(
      "Sorry, I ran into an error talking to Claude. Please try again."
    );
  }
});

// ── Interaction handler (buttons, selects, modals) ────────────────────────────
discord.on(Events.InteractionCreate, async (interaction) => {
  // Route all order-related interactions to the order module
  const isOrderInteraction =
    (interaction.isButton() &&
      (interaction.customId.startsWith("meal_") ||
        interaction.customId.startsWith("order_"))) ||
    (interaction.isStringSelectMenu() &&
      interaction.customId.startsWith("order_")) ||
    (interaction.isModalSubmit() && interaction.customId === "order_modal");

  if (isOrderInteraction) {
    try {
      await handleInteraction(interaction);
    } catch (err) {
      console.error("Order interaction error:", err);
      // Safely reply if we haven't responded yet
      const replyFn = interaction.deferred || interaction.replied
        ? interaction.followUp.bind(interaction)
        : interaction.reply.bind(interaction);
      await replyFn({ content: "⚠️ Error! Please try the command again!", ephemeral: true });
    }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split a string into ≤2000-character chunks, breaking on newlines where
 * possible so markdown code blocks don't get cut mid-line.
 */
function splitMessage(text, maxLen = 1900) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Start ─────────────────────────────────────────────────────────────────────
discord.login(process.env.DISCORD_TOKEN);
