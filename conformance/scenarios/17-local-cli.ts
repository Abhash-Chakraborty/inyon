import { BOX, type Scenario } from '../lib/scenario.ts'
import { onlineWith } from '../lib/wait.ts'

export default {
  name: 'local-cli',
  title: 'The inyon command on the hub machine lists the machines with the local token; anyone else is refused',
  machine: () => {},
  async run(ctx) {
    const token = ctx.hub.localToken()
    ctx.norm.learn(token, 'local-token')
    await ctx.signIn()
    await ctx.step('box connects')
    await ctx.connectNode()
    const app = await ctx.connect()
    app.send({ t: 'sub.overview' })
    await app.until('box online', onlineWith(BOX, 0))

    await ctx.step('with the token, as a header or in the query')
    await ctx.rest('GET', '/api/local/nodes', undefined, { as: { bearer: token } })
    await ctx.rest('GET', `/api/local/nodes?token=${token}`, undefined, { as: 'anon' })
    await ctx.step('without it, with a wrong one, with only the browser sign-in')
    await ctx.rest('GET', '/api/local/nodes', undefined, { as: 'anon' })
    await ctx.rest('GET', '/api/local/nodes', undefined, { as: { bearer: 'not-the-local-token' } })
    await ctx.rest('GET', '/api/local/nodes')
  },
} satisfies Scenario
