class StoreWrapper {
  constructor (store) {
    this._store = store
    this._cache = new Map()
    this._write = Promise.resolve()
  }

  async load (key) {
    if (!this._store) return
    if (this._cache.get(key)) return
    const value = await this._store.get(key)

    if (!this._cache.get(key)) this._cache.set(key, value)
  }

  get (key) {
    return this._cache.get(key)
  }

  set (key, value) {
    this._cache.set(key, value)
    this._write = this._write.then(() => {
      return this._store.put(key, value)
    })
  }

  setCache (key, value) {
    this._cache.set(key, value)
  }
}

module.exports = StoreWrapper
