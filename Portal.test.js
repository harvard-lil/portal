import test from 'node:test'
import assert from 'node:assert/strict'
import { Server } from 'http'

import { createServer } from './Portal.js'

test('createServer returns an instance of http.Server', async () => {
  assert.equal(createServer().constructor, Server)
})
