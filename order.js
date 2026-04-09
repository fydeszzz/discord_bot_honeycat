/**
 * order.js — Ordering Module
 *
 * Flow:
 *  1. User enters !order → Display meal category buttons (Breakfast / Lunch - Coming Soon)
 *  2. Click "Breakfast" → Show embedded dropdown menus (Main Dish, Main Ingredient, Toppings (multi-select), Sauces)
 *  3. Click "Submit Order" → Open a Modal for the user to enter notes
 *  4. Submit Modal → Bot publicly replies with an order summary embed
 *
 * Menu content is loaded from "menu.json", so the menu can be updated without modifying this file.
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

// ── Read and analyze menu.txt ───────────────────────────────────────────────────────
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

// ── Turn JSON array into Discord SelectMenuOption ───────────────────────────────
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
  const mainDish = MENU["主餐"]    ?? [];
  const protein  = MENU["主食材"]  ?? [];
  const toppings = MENU["配料"]    ?? [];
  const sauce    = MENU["醬料"]    ?? [];

  // Row 1: Main dish
  const mainRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_main")
      .setPlaceholder("① 請選擇主餐 🍞")
      .addOptions(toOptions(mainDish))
  );

  // Row 2: Main ingredient
  const proteinRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_protein")
      .setPlaceholder("② 請選擇主食材 🥩")
      .addOptions(toOptions(protein))
  );

  // Row 3: Toppings (multiple)
  const toppingRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_toppings")
      .setPlaceholder("③ 請選擇配料（可多選，含加蛋）🥗")
      .setMinValues(0)
      .setMaxValues(toppings.length || 1)
      .addOptions(toOptions(toppings))
  );

  // Row 4: Sauce
  const sauceRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("order_sauce")
      .setPlaceholder("④ 請選擇醬料 🫙")
      .addOptions(toOptions(sauce))
  );

  // Row 5: Submit and Cancel buttons
  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("order_submit")
      .setLabel("✅ 送出訂單")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("order_cancel")
      .setLabel("❌ 取消")
      .setStyle(ButtonStyle.Danger),
  );

  return [mainRow, proteinRow, toppingRow, sauceRow, btnRow];
}

// ── Public: handle !點餐 / !order command ──────────────────────────────────────────────
export async function handleOrderCommand(message) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("meal_breakfast")
      .setLabel("🌅 早餐")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("meal_lunch")
      .setLabel("☀️ 午餐(coming soon)")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  await message.reply({
    content: "## 🍽️ 歡迎使用小寶寶點餐服務！\n請選擇餐別：",
    components: [row],
  });
}

// ── Public: route all order-related interactions ───────────────────────────────
export async function handleInteraction(interaction) {
  const userId = interaction.user.id;

  // ── Choose breakfast ─────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "meal_breakfast") {
    sessions.set(userId, {
      mealType: "早餐",
      mainDish: null,
      protein: null,
      toppings: [],
      sauce: null,
    });

    await interaction.reply({
      content:
        "### 🌅 早餐點餐單\n" +
        "請依序選擇下方各項目（**主餐、主食材、醬料為必選**），完成後按 **送出訂單**。\n" +
        "> 配料可多選，也可以不選。",
      components: buildBreakfastComponents(),
      ephemeral: true,
    });
    return;
  }

  // ── Cancel ──────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "order_cancel") {
    sessions.delete(userId);
    await interaction.update({
      content: "❌ 已取消點餐。",
      components: [],
    });
    return;
  }

  // ── Dropdown menu: save session ────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const session = sessions.get(userId);
    if (!session) {
      await interaction.reply({
        content: "⚠️ 點餐 session 已過期，請重新輸入 `!點餐`。",
        ephemeral: true,
      });
      return;
    }

    switch (interaction.customId) {
      case "order_main":    session.mainDish = interaction.values[0]; break;
      case "order_protein": session.protein  = interaction.values[0]; break;
      case "order_toppings":session.toppings = interaction.values;    break;
      case "order_sauce":   session.sauce    = interaction.values[0]; break;
    }

    await interaction.deferUpdate();
    return;
  }

  // ── Submit button: validate required fields and show note modal ───────────────
  if (interaction.isButton() && interaction.customId === "order_submit") {
    const session = sessions.get(userId);
    if (!session) {
      await interaction.reply({
        content: "⚠️ 點餐 session 已過期，請重新輸入 `!點餐`。",
        ephemeral: true,
      });
      return;
    }

    const missing = [];
    if (!session.mainDish) missing.push("主餐");
    if (!session.protein)  missing.push("主食材");
    if (!session.sauce)    missing.push("醬料");

    if (missing.length > 0) {
      await interaction.reply({
        content: `⚠️ 以下必選項目尚未選擇：**${missing.join("、")}**\n請選完後再送出。`,
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId("order_modal")
      .setTitle("📝 備註（選填）");

    const noteInput = new TextInputBuilder()
      .setCustomId("order_note")
      .setLabel("有什麼特別需求嗎？（可留空直接送出）")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder("ex: 不要太辣、醬料放旁邊...")
      .setMaxLength(200);

    modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal submit: show order confirmation ───────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "order_modal") {
    const session = sessions.get(userId);
    if (!session) {
      await interaction.reply({
        content: "⚠️ 點餐資料遺失，請重新輸入 `!點餐`。",
        ephemeral: true,
      });
      return;
    }

    const note = interaction.fields.getTextInputValue("order_note").trim();
    sessions.delete(userId);

    const toppingText =
      session.toppings.length > 0
        ? session.toppings.map(label).join("、")
        : "無";

    const embed = new EmbedBuilder()
      .setTitle("🧾 訂單確認")
      .setColor(0x57f287)
      .setDescription(`感謝 **${interaction.user.displayName}** 的點餐！您的訂單如下：`)
      .addFields(
        { name: "📋 餐別",   value: session.mealType,           inline: true },
        { name: "🍞 主餐",   value: label(session.mainDish),    inline: true },
        { name: "🥩 主食材", value: label(session.protein),     inline: true },
        { name: "🥗 配料",   value: toppingText,                inline: true },
        { name: "🫙 醬料",   value: label(session.sauce),       inline: true },
        { name: "📝 備註",   value: note || "無",               inline: true },
      )
      .setFooter({ text: "訂單已成立，請回家後取餐！" })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    return;
  }
}
