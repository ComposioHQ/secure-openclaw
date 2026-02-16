import 'dotenv/config'
import http from 'http'
import QRCode from 'qrcode'
import config from './config.js'
import WhatsAppAdapter from './adapters/whatsapp.js'
import iMessageAdapter from './adapters/imessage.js'
import TelegramAdapter from './adapters/telegram.js'
import DiscordAdapter from './adapters/discord.js'
import SignalAdapter from './adapters/signal.js'
import SessionManager from './sessions/manager.js'
import AgentRunner from './agent/runner.js'
import CommandHandler from './commands/handler.js'
import { Composio } from '@composio/core'

/**
 * Secure OpenClaw Gateway - Routes messages between messaging platforms and Claude agent
 */
class Gateway {
  constructor() {
    this.sessionManager = new SessionManager()
    this.agentRunner = new AgentRunner(this.sessionManager, {
      allowedTools: config.agent?.allowedTools || ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: config.agent?.maxTurns || 50,
      provider: config.agent?.provider || 'claude',
      permissionMode: 'bypassPermissions',
      opencode: config.agent?.opencode || {}
    })
    this.commandHandler = new CommandHandler(this)
    this.adapters = new Map()
    this.pendingApprovals = new Map() // chatId -> { resolve, timeout }
    this.composio = new Composio()
    this.composioSession = null
    this.mcpServers = {}
    this.setupQueueMonitoring()
    this.setupAgentMonitoring()
    this.setupCronExecution()
  }

  async initMcpServers() {
    const userId = config.agentId || 'secure-openclaw-user'
    console.log('[Composio] Initializing session for:', userId)
    try {
      this.composioSession = await this.composio.create(userId)
      this.mcpServers.composio = {
        type: 'http',
        url: this.composioSession.mcp.url,
        headers: this.composioSession.mcp.headers
      }
      console.log('[Composio] Session ready')
    } catch (err) {
      console.error('[Composio] Failed to initialize:', err.message)
    }

  }

  setupQueueMonitoring() {
    this.agentRunner.on('queued', ({ runId, sessionKey, position, queueLength }) => {
      if (position > 0) {
        console.log(`[Queue] 📥 Queued: position ${position + 1}, ${queueLength} pending`)
      }
    })

    this.agentRunner.on('processing', ({ runId, waitTimeMs, remainingInQueue }) => {
      if (waitTimeMs > 100) {
        console.log(`[Queue] ⚙️  Processing (waited ${Math.round(waitTimeMs)}ms, ${remainingInQueue} remaining)`)
      }
    })

    this.agentRunner.on('completed', ({ runId, processingTimeMs }) => {
      console.log(`[Queue] ✓ Completed in ${Math.round(processingTimeMs)}ms`)
    })

    this.agentRunner.on('failed', ({ runId, error }) => {
      console.log(`[Queue] ✗ Failed: ${error}`)
    })
  }

  setupAgentMonitoring() {
    this.agentRunner.on('agent:tool', ({ sessionKey, name }) => {
      console.log(`[Agent] 🔧 Using tool: ${name}`)
    })
  }

  setupCronExecution() {
    // Handle cron job execution - send scheduled messages or invoke agent
    this.agentRunner.agent.cronScheduler.on('execute', async ({ jobId, platform, chatId, sessionKey, message, invokeAgent }) => {
      console.log(`[Cron] ⏰ Executing job ${jobId}${invokeAgent ? ' (invoking agent)' : ''}`)

      const adapter = this.adapters.get(platform)
      if (!adapter) {
        console.error(`[Cron] No adapter for platform: ${platform}`)
        return
      }

      try {
        if (invokeAgent) {
          // Run the agent with the message and send the response
          console.log(`[Cron] Invoking agent with: ${message}`)
          const response = await this.agentRunner.agent.runAndCollect({
            message,
            sessionKey: sessionKey || `cron:${jobId}`,
            platform,
            chatId,
            mcpServers: this.mcpServers
          })

          if (response) {
            await adapter.sendMessage(chatId, response)
            console.log(`[Cron] Agent response sent for job ${jobId}`)
          }
        } else {
          // Just send the message directly
          await adapter.sendMessage(chatId, message)
          console.log(`[Cron] Message sent for job ${jobId}`)
        }
      } catch (err) {
        console.error(`[Cron] Failed to execute job:`, err.message)
      }
    })
  }

  /**
   * Send a message and wait for the user's reply.
   * Used for tool approval prompts and clarifying questions.
   */
  waitForApproval(chatId, adapter, message, timeoutMs = 120000) {
    // Clear any existing pending approval for this chat
    const existing = this.pendingApprovals.get(chatId)
    if (existing) {
      clearTimeout(existing.timeout)
      existing.resolve(null)
    }

    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(chatId)
        resolve(null) // Timeout = no response
      }, timeoutMs)

      this.pendingApprovals.set(chatId, { resolve, timeout })

      try {
        await adapter.sendMessage(chatId, message)
      } catch (err) {
        console.error('[Gateway] Failed to send approval prompt:', err.message)
        clearTimeout(timeout)
        this.pendingApprovals.delete(chatId)
        resolve(null)
      }
    })
  }

  async start() {
    console.log('='.repeat(50))
    console.log('Secure OpenClaw Gateway Starting')
    console.log('='.repeat(50))
    console.log(`Agent ID: ${config.agentId}`)
    console.log(`Workspace: ~/secure-openclaw/`)
    console.log('')

    const platforms = ['whatsapp', 'imessage', 'telegram', 'signal']
    for (const p of platforms) {
      const pc = config[p]
      if (!pc?.enabled) continue
      const dms = pc.allowedDMs?.length ? pc.allowedDMs.join(', ') : 'NONE (all blocked)'
      const groups = pc.allowedGroups?.length ? pc.allowedGroups.join(', ') : 'NONE (all blocked)'
      console.log(`[Security] ${p}: DMs=${dms} | Groups=${groups}`)
    }

    await this.initMcpServers()
    this.agentRunner.setMcpServers(this.mcpServers)

    // Pre-initialize provider (connect/start server before messages arrive)
    if (this.agentRunner.agent.provider.initialize) {
      try {
        await this.agentRunner.agent.provider.initialize()
        console.log('[Provider] Ready')
      } catch (err) {
        console.error('[Provider] Init failed:', err.message)
      }
    }

    this.agentRunner.agent.gateway = this

    // Initialize WhatsApp adapter
    if (config.whatsapp.enabled) {
      console.log('[Gateway] Initializing WhatsApp adapter...')
      const whatsapp = new WhatsAppAdapter(config.whatsapp)
      this.setupAdapter(whatsapp, 'whatsapp', config.whatsapp)
      this.adapters.set('whatsapp', whatsapp)

      try {
        await whatsapp.start()
      } catch (err) {
        console.error('[Gateway] WhatsApp adapter failed to start:', err.message)
      }
    }

    // Initialize iMessage adapter
    if (config.imessage.enabled) {
      console.log('[Gateway] Initializing iMessage adapter...')
      const imessage = new iMessageAdapter(config.imessage)
      this.setupAdapter(imessage, 'imessage', config.imessage)
      this.adapters.set('imessage', imessage)

      try {
        await imessage.start()
      } catch (err) {
        console.error('[Gateway] iMessage adapter failed to start:', err.message)
      }
    }


    if (config.telegram?.enabled) {
      console.log('[Gateway] Initializing Telegram adapter...')
      const telegram = new TelegramAdapter(config.telegram)
      this.setupAdapter(telegram, 'telegram', config.telegram)
      this.adapters.set('telegram', telegram)

      try {
        await telegram.start()
      } catch (err) {
        console.error('[Gateway] Telegram adapter failed to start:', err.message)
      }
    }

    // Initialize Discord adapter
    if (config.discord?.enabled) {
      console.log('[Gateway] Initializing Discord adapter...')
      const discord = new DiscordAdapter(config.discord)
      this.setupAdapter(discord, 'discord', config.discord)
      this.adapters.set('discord', discord)

      try {
        await discord.start()
      } catch (err) {
        console.error('[Gateway] Discord adapter failed to start:', err.message)
      }
    }

    // Initialize Signal adapter
    if (config.signal?.enabled) {
      console.log('[Gateway] Initializing Signal adapter...')
      const signal = new SignalAdapter(config.signal)
      this.setupAdapter(signal, 'signal', config.signal)
      this.adapters.set('signal', signal)

      try {
        await signal.start()
      } catch (err) {
        console.error('[Gateway] Signal adapter failed to start:', err.message)
      }
    }

    // Handle shutdown
    process.on('SIGINT', () => this.stop())
    process.on('SIGTERM', () => this.stop())

    // Start HTTP server for health checks and WhatsApp QR code
    this.startHttpServer()

    console.log('')
    console.log('[Gateway] Ready and listening for messages')
    console.log('[Gateway] Using Claude Agent SDK with memory + cron + Composio')
    console.log('[Gateway] Commands: /help, /new, /status, /memory, /stop')
  }

  setupAdapter(adapter, platform, platformConfig) {
    adapter.onMessage(async (message) => {
      const sessionKey = adapter.generateSessionKey(config.agentId, platform, message)

      console.log('')
      console.log(`[${platform.toUpperCase()}] Incoming message:`)
      console.log(`  Session: ${sessionKey}`)
      console.log(`  From: ${message.sender}`)
      console.log(`  Group: ${message.isGroup}`)
      console.log(`  Text: ${message.text.substring(0, 100)}${message.text.length > 100 ? '...' : ''}`)
      if (message.image) {
        console.log(`  Image: ${Math.round(message.image.data.length / 1024)}KB`)
      }

      // Check for pending approval — if one exists, resolve it with the user's reply
      const pending = this.pendingApprovals.get(message.chatId)
      if (pending) {
        console.log(`[${platform.toUpperCase()}] Resolving pending approval with: ${message.text}`)
        clearTimeout(pending.timeout)
        this.pendingApprovals.delete(message.chatId)
        pending.resolve(message.text)
        return
      }

      // Check for pending /model or /provider selection
      if (this.commandHandler.handlePendingReply(message.text, message.chatId)) {
        console.log(`[${platform.toUpperCase()}] Resolved pending command selection: ${message.text}`)
        return
      }

      try {
        // Check for slash commands first
        const commandResult = await this.commandHandler.execute(
          message.text,
          sessionKey,
          adapter,
          message.chatId
        )

        if (commandResult.handled) {
          console.log(`[${platform.toUpperCase()}] Command handled: ${message.text.split(' ')[0]}`)
          if (commandResult.response) {
            await adapter.sendMessage(message.chatId, commandResult.response)
          }
          return
        }

        // Check queue status and show typing indicator
        const queueStatus = this.agentRunner.getQueueStatus(sessionKey)

        if (adapter.sendTyping) {
          await adapter.sendTyping(message.chatId)
        }

        if (queueStatus.pending > 0 && adapter.react && message.raw?.key?.id) {
          await adapter.react(message.chatId, message.raw.key.id, '⏳')
        }

        // Enqueue agent run with optional image
        console.log(`[${platform.toUpperCase()}] Processing...`)
        const response = await this.agentRunner.enqueueRun(
          sessionKey,
          message.text,
          adapter,
          message.chatId,
          message.image  // Pass image if present
        )

        if (adapter.stopTyping) {
          await adapter.stopTyping(message.chatId)
        }

        console.log(`[${platform.toUpperCase()}] Done`)
      } catch (error) {
        console.error(`[${platform.toUpperCase()}] Error:`, error.message)

        if (adapter.stopTyping) {
          await adapter.stopTyping(message.chatId)
        }

        try {
          await adapter.sendMessage(
            message.chatId,
            "Sorry, I encountered an error. Please try again."
          )
        } catch (sendErr) {
          console.error(`[${platform.toUpperCase()}] Failed to send error message:`, sendErr.message)
        }
      }
    })
  }

  startHttpServer() {
    const port = process.env.PORT || 4096

    this.httpServer = http.createServer(async (req, res) => {
      if (req.url === '/qr') {
        const wa = this.adapters.get('whatsapp')
        if (!wa || !wa.latestQr) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          const status = wa?.myJid ? 'WhatsApp is connected.' : 'No QR code available. Waiting for WhatsApp...'
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>WhatsApp QR</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff}</style></head><body><p>${status}</p></body></html>`)
          return
        }

        try {
          const qrDataUrl = await QRCode.toDataURL(wa.latestQr, { width: 400, margin: 2 })
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>WhatsApp QR</title><style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff}img{border-radius:12px}</style></head><body><h2>Scan with WhatsApp</h2><img src="${qrDataUrl}" alt="QR Code"/><p>Page refreshes automatically.</p></body></html>`)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Failed to generate QR')
        }
        return
      }

      // Health check / status
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const adaptersStatus = {}
      for (const [name, adapter] of this.adapters) {
        adaptersStatus[name] = { connected: !!adapter.sock || !!adapter.bot }
      }
      res.end(JSON.stringify({ status: 'ok', adapters: adaptersStatus }))
    })

    this.httpServer.listen(port, () => {
      console.log(`[HTTP] Listening on port ${port} (QR code at /qr)`)
    })
  }

  async stop() {
    console.log('\n[Gateway] Shutting down...')

    // Stop cron scheduler
    this.agentRunner.agent.stopCron()

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop()
      } catch (err) {
        console.error('[Gateway] Error stopping adapter:', err.message)
      }
    }

    console.log('[Gateway] Goodbye!')
    process.exit(0)
  }
}

// Start the gateway
const gateway = new Gateway()
gateway.start().catch((err) => {
  console.error('[Gateway] Fatal error:', err)
  process.exit(1)
})
