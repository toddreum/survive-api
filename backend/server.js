import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => res.json({ ok: true }))

/**
 * POST /api/boost/checkout
 * Body: { playerId: string }
 * Uses env:
 *  - HEALTH_BOOST: Stripe secret key
 *  - PRICE_ID: price_1SKx5OFDHekJoy7r5qaffevP
 *  - FRONTEND_URL (optional): where to send success/cancel
 */
app.post('/api/boost/checkout', async (req, res) => {
  try {
    const stripeKey = process.env.HEALTH_BOOST
    const priceId = process.env.PRICE_ID || 'price_1SKx5OFDHekJoy7r5qaffevP'
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'

    if (!stripeKey) {
      return res.status(500).json({ error: 'Stripe key not configured (HEALTH_BOOST).' })
    }

    const stripe = (await import('stripe')).default
    const client = new stripe(stripeKey)

    const session = await client.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      payment_intent_data: {
        metadata: {
          product: 'Health Boost +5',
          type: 'survive.health.boost'
        }
      },
      // NOTE: success & cancel redirect back to frontend (pause menu) — resume then applies +5 in your UI logic.
      success_url: `${frontendUrl}/?boost=success`,
      cancel_url: `${frontendUrl}/?boost=cancel`
    })

    return res.json({ url: session.url })
  } catch (e) {
    console.error('Stripe checkout error', e)
    return res.status(500).json({ error: 'Checkout error' })
  }
})

const port = process.env.PORT || 3001
app.listen(port, () => console.log('Backend listening on', port))
