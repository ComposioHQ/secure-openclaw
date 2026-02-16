import { Client, GatewayIntentBits, Partials } from 'discord.js'
import BaseAdapter from './base.js'

/**
 * Discord adapter using discord.js
 * Supports DMs and guild channels
 */
export default class DiscordAdapter extends BaseAdapter {
  constructor(config) {
    super(config)
    this.client = null
  }

  async start() {
    if (!this.config.token) {
      throw new Error('Discord bot token is required. Get one from the Discord Developer Portal.')
    }

    // These intents are required for the bot to see messages and channels
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel] // Required for DMs
    })

    this.client.once('ready', () => {
      console.log(`[Discord] Connected as @${this.client.user.tag}`)
      console.log('[Discord] Adapter started')
    })

    // Handle incoming messages
    this.client.on('messageCreate', async (msg) => {
      await this.handleMessage(msg)
    })

    // Handle errors
    this.client.on('error', (err) => {
      console.error('[Discord] Client error:', err.message)
    })

    await this.client.login(this.config.token)
  }

  async stop() {
    if (this.client) {
      await this.client.destroy()
      this.client = null
    }
    console.log('[Discord] Adapter stopped')
  }

  async sendMessage(chatId, text) {
    if (!this.client) {
      throw new Error('Discord not connected')
    }

    const channel = await this.client.channels.fetch(chatId)
    if (!channel || !channel.isTextBased()) {
      console.error(`[Discord] Cannot send message to channel ${chatId} (not a text channel)`)
      return
    }

    // Discord has a 2000 character limit
    if (text.length > 2000) {
      const chunks = this.splitMessage(text, 2000)
      for (const chunk of chunks) {
        await channel.send(chunk)
      }
    } else {
      await channel.send(text)
    }
  }

  splitMessage(text, maxLength) {
    const chunks = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining)
        break
      }
      // Find a good break point
      let breakPoint = remaining.lastIndexOf('\n', maxLength)
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength)
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength
      }
      chunks.push(remaining.substring(0, breakPoint))
      remaining = remaining.substring(breakPoint).trim()
    }
    return chunks
  }

  async handleMessage(msg) {
    // Ignore messages from bots
    if (msg.author.bot) return

    // Standardize message format
    const isGroup = !!msg.guild
    const chatId = msg.channel.id
    const sender = msg.author.id
    const guildId = isGroup ? msg.guild.id : null

    // Check for bot mention
    const botMentioned = msg.mentions.has(this.client.user.id)
    let text = msg.content

    // In groups, only respond if mentioned (and configured to do so)
    if (isGroup && this.config.respondToMentionsOnly && !botMentioned) {
      return
    }

    // Remove the bot mention from the text to clean it up for the agent
    if (botMentioned) {
      text = text.replace(/<@!?\d+>/g, '').trim()
    }

    const message = {
      chatId,
      text,
      isGroup,
      sender,
      mentions: botMentioned ? ['self'] : [],
      raw: msg,
      // Use guildId for group allowlist check, or chatId for DM allowlist
      allowlistId: isGroup ? guildId : sender
    }

    // Custom shouldRespond check for Discord
    if (!this.shouldRespondDiscord(message, this.config)) {
      return
    }

    this.emitMessage(message)
  }

  /**
   * Custom security check for Discord's structure (Guilds vs DMs)
   */
  shouldRespondDiscord(message, config) {
    const { isGroup, sender, allowlistId } = message

    if (isGroup) {
      if (config.allowedGuilds.length === 0) {
        console.log(`[Security] Blocked group message from guild ${allowlistId} (no guilds allowed)`)
        return false
      }
      if (!config.allowedGuilds.includes('*') && !config.allowedGuilds.includes(allowlistId)) {
        console.log(`[Security] Blocked group message from guild ${allowlistId} (not in allowlist)`)
        return false
      }
    } else { // DM
      if (config.allowedDMs.length === 0) {
        console.log(`[Security] Blocked DM from ${sender} (no DMs allowed)`)
        return false
      }
      if (!config.allowedDMs.includes('*') && !config.allowedDMs.includes(sender)) {
        console.log(`[Security] Blocked DM from ${sender} (not in allowlist)`)
        return false
      }
    }

    return true
  }
}
