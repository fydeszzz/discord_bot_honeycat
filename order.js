/**
 * order.js — Ordering Module
 *
 * Flow:
 *  1. User enters !order or !點餐 → Display meal category buttons (Breakfast / Lunch - Coming Soon)
 *  2. Click "Breakfast" → Show embedded dropdown menus (Main Dish, Protein, Toppings, Sauce)
 *  3. Click "Submit Order" → Open a Modal for the user to enter notes
 *  4. Submit Modal → Bot publicly replies with an order summary embed
 *
 * Menu content is loaded from menu.txt — update the menu without touching this file.
 */

import { readFileSync } from "fs";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from "discord.js";

// ── Parse menu.txt ────────────────────────────────────────────────────────────
function parseMenu(filePath) {
  const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
  const menu = {};
  const LABELS = {};
  let currentSection = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      menu[currentSection] = [];
      continue;
    }

    if (!currentSection) continue;

    const [labelText, emoji] = line.split(",").map((s) => s.trim());
    if (!labelText) continue;

    const value = labelText;
    menu[currentSection].push({ label: labelText, value, emoji: emoji ?? null });
    LABELS[value] = labelText;
  }

  return { menu, LABELS };
}

const { menu: MENU, LABELS } = parseMenu(
  new URL("./menu.txt", import.meta.url)
);

const label = (v) => LABELS[v] ?? v;

// ── In-memory sessions ────────────────────────────────────────────────────────
// userId → { mealType, mainDish, protein, toppings, sauce }
const sessions = new Map();

// ── Convert item array to Discord SelectMenuOptions ───────────────────────────
function toOptions(items) {
  return items.map((item) => {
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(item.label)
      .setValue(item.value);
    if (item.emoji) opt.setEmoji(item.emoji);
    return opt;
  });
}

// ── Build breakfast form components ──────────────────────────────────────────
function buildBreakfastComponents() {
  const mainDish = MENU["Main Dish"] ?? [];
  const protein  = MENU["Protein"]   ?? [];
  const toppings = MENU["Toppings"]  ?? [];
  const sauce    = MENU["Sauce"]     ?? [];

  // Row 1: Main Dish
  const mainRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_main")
      .setPlaceholder("① Select Main Dish 🍞")
      .addOptions(toOptions(mainDish))
  );

  // Row 2: Protein
  const proteinRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_protein")
      .setPlaceholder("② Select Protein 🥩")
      .addOptions(toOptions(protein))
  );

  // Row 3: Toppings (multi-select, optional)
  const toppingRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_toppings")
      .setPlaceholder("③ Select Toppings (optional, multi-select) 🥗")
      .setMinValues(0)
      .setMaxValues(toppings.length || 1)
      .addOptions(toOptions(toppings))
  );

  // Row 4: Sauce
  const sauceRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_sauce")
      .setPlaceholder("④ Select Sauce 🫙")
      .addOptions(toOptions(sauce))
  );

  // Row 5: Action buttons
  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("order_submit")
      .setLabel("✅ Submit Order")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("order_cancel")
      .setLabel("❌ Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  return [mainRow, proteinRow, toppingRow, sauceRow, btnRow];
}

// ── Public: handle !order / !點餐 command ─────────────────────────────────────
export async function handleOrderCommand(message) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("meal_breakfast")
      .setLabel("🌅 Breakfast")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("meal_lunch")
      .setLabel("☀️ Lunch (Coming Soon)")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  await message.reply({
    content: "## 🍽️ Welcome to the Ordering Service!\nPlease select a meal:",
    components: [row],
  });
}

// ── Public: route all order-related interactions ───────────────────────────────
export async function handleInteraction(interaction) {
  const userId = interaction.user.id;

  // ── Breakfast button ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "meal_breakfast") {
    sessions.set(userId, {
      mealType: "Breakfast",
      mainDish: null,
      protein: null,
      toppings: [],
      sauce: null,
    });

    await interaction.reply({
      content:
        "### 🌅 Breakfast Order Form\n" +
        "Please select each item below (**Main Dish, Protein, and Sauce are required**), then click **Submit Order**.\n" +
        "> Toppings are optional — you can skip them.",
      components: buildBreakfastComponents(),
      ephemeral: true,
    });
    return;
  }

  // ── Cancel button ─────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "order_cancel") {
    sessions.delete(userId);
    await interaction.update({
      content: "❌ Order cancelled.",
      components: [],
    });
    return;
  }

  // ── Dropdown menus: save to session ───────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const session = sessions.get(userId);
    if (!session) {
      await interaction.reply({
        content: "⚠️ Your session has expired. Please use `!order` to start again.",
        ephemeral: true,
      });
      return;
    }

    switch (interaction.customId) {
      case "order_main":     session.mainDish = interaction.values[0]; break;
      case "order_protein":  session.protein  = interaction.values[0]; break;
      case "order_toppings": session.toppings = interaction.values;    break;
      case "order_sauce":    session.sauce    = interaction.values[0]; break;
    }

    await interaction.deferUpdate();
    return;
  }

  // ── Submit button: validate required fields then show notes modal ──────────
  if (interaction.isButton() && interaction.customId === "order_submit") {
    const session = sessions.get(userId);
    if (!session) {
      await interaction.reply({
        content: "⚠️ Your session has expired. Please use `!order` to start again.",
        ephemeral: true,
      });
      return;
    }

    const missing = [];
    if (!session.mainDish) missing.push("Main Dish");
    if (!session.protein)  missing.push("Protein");
    if (!session.sauce)    missing.push("Sauce");

    if (missing.length > 0) {
      await interaction.reply({
        content: `⚠️ Please select the following required items: **${missing.join(", ")}**`,
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId("order_modal")
      .setTitle("📝 Special Requests (Optional)");

    const noteInput = new TextInputBuilder()
      .setCustomId("order_note")
      .setLabel("Any special requests? (Leave blank to skip)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder("e.g. Less spicy, sauce on the side...")
      .setMaxLength(200);

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal submit: display order confirmation ───────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "order_modal") {
    const session = sessions.get(userId);
    if (!session) {
      await interaction.reply({
        content: "⚠️ Order data lost. Please use `!order` to start again.",
        ephemeral: true,
      });
      return;
    }

    const note = interaction.fields.getTextInputValue("order_note").trim();
    sessions.delete(userId);

    const toppingText =
      session.toppings.length > 0
        ? session.toppings.map(label).join(", ")
        : "None";

    const embed = new EmbedBuilder()
      .setTitle("🧾 Order Confirmed")
      .setColor(0x57f287)
      .setDescription(`Thank you **${interaction.user.displayName}** for your order!`)
      .addFields(
        { name: "📋 Meal",       value: session.mealType,        inline: true },
        { name: "🍞 Main Dish",  value: label(session.mainDish), inline: true },
        { name: "🥩 Protein",    value: label(session.protein),  inline: true },
        { name: "🥗 Toppings",   value: toppingText,             inline: true },
        { name: "🫙 Sauce",      value: label(session.sauce),    inline: true },
        { name: "📝 Notes",      value: note || "None",          inline: true },
      )
      .setFooter({ text: "Your order has been placed. Enjoy your meal!" })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }
}
