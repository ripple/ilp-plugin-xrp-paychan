'use strict'

// TODO: faster library for crypto?
const nacl = require('tweetnacl')
const BigNumber = require('bignumber.js')
const co = require('co')
const util = require('../util')
const Balance = require('./balance')
const EventEmitter2 = require('eventemitter2')
const encode = require('../util/encode')
const debug = require('debug')('ilp-plugin-xrp-paychan:outgoing-channel')

module.exports = class OutgoingChannel extends EventEmitter2 {
  constructor (opts) {
    super()

    this._api = opts.api
    this._address = opts.address
    this._secret = opts.secret
    this._amount = opts.amount
    this._fundPercent = new BigNumber('0.8')
    this._destination = opts.destination
    this._store = opts.store
    this._keyPair = nacl.sign.keyPair.fromSeed(util.sha256(opts.channelSecret))
    this._balance = new Balance({
      //     123456789
      name: 'balance_o',
      maximum: this._amount,
      store: this._store
    })
  }

  * getBalance () {
    if (!this._channelId) throw new Error('must be connected before getBalance')
    return yield this._balance.get()
  }

  * create () {
    const existingChannel = yield this._store.get('channel_o')
    if (existingChannel) {
      debug('fetching existing channel id', existingChannel, 'and returning.')
      this._channelId = existingChannel
      this._hash = yield this._store.get('hash_o')
      debug('fetching stored hash', this._hash)
      return
    }

    const txTag = util.randomTag()
    const tx = yield this._api.preparePaymentChannelCreate(this._address, {
      amount: util.dropsToXrp(this._amount),
      destination: this._destination,
      settleDelay: 90000,
      publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
      sourceTag: txTag
      // TODO: specify a cancelAfter?
    })

    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = yield this._api.submit(signedTx.signedTransaction)

    return new Promise((resolve) => {
      function handleTransaction (ev) {
        if (ev.transaction.SourceTag !== txTag) return
        if (ev.transaction.Account !== this._address) return

        const channelId = util.channelId(
          this._address,
          this._destination,
          ev.transaction.Sequence)

        debug('created outgoing channel with ID:', channelId)
        this._channelId = channelId
        this._hash = ev.transaction.hash

        this._store.put('channel_o', channelId)
          .then(() => this._store.put('hash_o', this._hash))
          .then(() => resolve())
          .catch((e) => {
            debug('store error:', e)
          })

        setImmediate(() => this._api.connection
          .removeListener('transaction', handleTransaction))
      }

      this._api.connection.on('transaction', handleTransaction.bind(this))
    })
  }

  getChannelId () {
    return this._channelId
  }

  getHash () {
    debug('fetching hash', this._hash)
    return this._hash
  }

  * send (transfer) {
    if (!this._channelId) {
      throw new Error('channel has not been created')
    }

    // this will complain if the amount exceeds the maximum
    yield this._balance.add(transfer.amount)
    const claim = yield this._balance.get()
    const threshold = this._balance.getMax().mul(this._fundPercent)

    if (threshold.lt(claim)) {
      debug('balance of', claim.toString(), 'exceeds threshold',
        threshold.toString(), '. triggering fund tx.')
      yield co.wrap(this._fundChannel).call(this).catch((e) => {
        console.error(e)
        throw e
      })
    }

    debug('creating outgoing claim for new balance:', claim.toString())
    const message = encode.getClaimMessage(this._channelId, claim)
    const signature = nacl.sign.detached(message, this._keyPair.secretKey)

    return Buffer.from(signature).toString('hex')
  }

  * _fundChannel () {
    this._balance.addMax(this._amount)
    const tx = yield this._api.preparePaymentChannelFund(this._address, {
      channel: this._channelId,
      amount: util.dropsToXrp(this._amount)
    })

    const signedTx = this._api.sign(tx.txJSON, this._secret)
    debug('submitting fund tx for an additional:', this._amount)
    const result = yield this._api.submit(signedTx.signedTransaction)

    const that = this
    function fundCheck (ev) {
      if (ev.transaction.TransactionType !== 'PaymentChannelFund') return

      debug('fund tx completed')
      that._api.connection.removeListener('transaction', fundCheck)
      return that.emitAsync('fund', ev.transaction)
    }

    this._api.connection.on('transaction', fundCheck)
  }
}
