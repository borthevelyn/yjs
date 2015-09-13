/* global Y */

'use strict'

class AbstractTransaction { // eslint-disable-line no-unused-vars
  constructor (store) {
    this.store = store
  }
  * getType (id) {
    var sid = JSON.stringify(id)
    var t = this.store.initializedTypes[sid]
    if (t == null) {
      var op = yield* this.getOperation(id)
      if (op != null) {
        t = yield* Y[op.type].initType.call(this, this.store, op)
        this.store.initializedTypes[sid] = t
      }
    }
    return t
  }
  * createType (model) {
    var sid = JSON.stringify(model.id)
    var t = yield* Y[model.type].initType.call(this, this.store, model)
    this.store.initializedTypes[sid] = t
    return t
  }
  * applyCreatedOperations (ops) {
    var send = []
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i]
      yield* this.store.tryExecute.call(this, op)
      send.push(Y.utils.copyObject(Y.Struct[op.struct].encode(op)))
    }
    if (this.store.y.connector.broadcastedHB) {
      this.store.y.connector.broadcast({
        type: 'update',
        ops: send
      })
    }
  }
}
Y.AbstractTransaction = AbstractTransaction

class AbstractOperationStore { // eslint-disable-line no-unused-vars
  constructor (y, opts) {
    this.y = y
    // E.g. this.listenersById[id] : Array<Listener>
    this.listenersById = {}
    // Execute the next time a transaction is requested
    this.listenersByIdExecuteNow = []
    // A transaction is requested
    this.listenersByIdRequestPending = false
    /* To make things more clear, the following naming conventions:
       * ls : we put this.listenersById on ls
       * l : Array<Listener>
       * id : Id (can't use as property name)
       * sid : String (converted from id via JSON.stringify
                       so we can use it as a property name)

      Always remember to first overwrite
      a property before you iterate over it!
    */
    // TODO: Use ES7 Weak Maps. This way types that are no longer user,
    // wont be kept in memory.
    this.initializedTypes = {}
    this.whenUserIdSetListener = null
    this.waitingOperations = new Y.utils.RBTree()

    this.gc1 = [] // first stage
    this.gc2 = [] // second stage -> after that, kill it
    this.gcTimeout = opts.gcTimeout || 5000
    var os = this
    function garbageCollect () {
      var def = Promise.defer()
      os.requestTransaction(function * () {
        for (var i in os.gc2) {
          var oid = os.gc2[i]
          var o = yield* this.getOperation(oid)
          if (o.left != null) {
            var left = yield* this.getOperation(o.left)
            left.right = o.right
            yield* this.setOperation(left)
          }
          if (o.right != null) {
            var right = yield* this.getOperation(o.right)
            right.left = o.left
            yield* this.setOperation(right)
          }
          var parent = yield* this.getOperation(o.parent)
          var setParent = false
          if (Y.utils.compareIds(parent.start, o.id)) {
            setParent = true
            parent.start = o.right
          }
          if (Y.utils.compareIds(parent.end, o.id)) {
            setParent = true
            parent.end = o.left
          }
          if (setParent) {
            yield* this.setOperation(parent)
          }
          yield* this.removeOperation(o.id)
        }
        os.gc2 = os.gc1
        os.gc1 = []
        if (os.gcTimeout > 0) {
          os.gcInterval = setTimeout(garbageCollect, os.gcTimeout)
        }
        def.resolve()
      })
      return def.promise
    }
    this.garbageCollect = garbageCollect
    if (this.gcTimeout > 0) {
      garbageCollect()
    }
  }
  addToGarbageCollector (op) {
    this.gc1.push(op)
  }
  destroy () {
    clearInterval(this.gcInterval)
    this.gcInterval = null
  }
  setUserId (userId) {
    this.userId = userId
    this.opClock = 0
    if (this.whenUserIdSetListener != null) {
      this.whenUserIdSetListener()
      this.whenUserIdSetListener = null
    }
  }
  whenUserIdSet (f) {
    if (this.userId != null) {
      f()
    } else {
      this.whenUserIdSetListener = f
    }
  }
  getNextOpId () {
    if (this.userId == null) {
      throw new Error('OperationStore not yet initialized!')
    }
    return [this.userId, this.opClock++]
  }
  apply (ops) {
    for (var key in ops) {
      var o = ops[key]
      if (!o.gc) {
        var required = Y.Struct[o.struct].requiredOps(o)
        this.whenOperationsExist(required, o)
      } else {
        throw new Error("Must not receive gc'd ops!")
      }
    }
  }
  // op is executed as soon as every operation requested is available.
  // Note that Transaction can (and should) buffer requests.
  whenOperationsExist (ids, op) {
    if (ids.length > 0) {
      let listener = {
        op: op,
        missing: ids.length
      }

      for (let key in ids) {
        let id = ids[key]
        let sid = JSON.stringify(id)
        let l = this.listenersById[sid]
        if (l == null) {
          l = []
          this.listenersById[sid] = l
        }
        l.push(listener)
      }
    } else {
      this.listenersByIdExecuteNow.push({
        op: op
      })
    }

    if (this.listenersByIdRequestPending) {
      return
    }

    this.listenersByIdRequestPending = true
    var store = this

    this.requestTransaction(function *() {
      var exeNow = store.listenersByIdExecuteNow
      store.listenersByIdExecuteNow = []

      var ls = store.listenersById
      store.listenersById = {}

      store.listenersByIdRequestPending = false

      for (let key in exeNow) {
        let o = exeNow[key].op
        yield* store.tryExecute.call(this, o)
      }

      for (var sid in ls) {
        var l = ls[sid]
        var id = JSON.parse(sid)
        if ((yield* this.getOperation(id)) == null) {
          store.listenersById[sid] = l
        } else {
          for (let key in l) {
            let listener = l[key]
            let o = listener.op
            if (--listener.missing === 0) {
              yield* store.tryExecute.call(this, o)
            }
          }
        }
      }
    })
  }
  * tryExecute (op) {
    if (op.struct === 'Delete') {
      yield* Y.Struct.Delete.execute.call(this, op)
    } else {
      while (op != null) {
        var state = yield* this.getState(op.id[0])
        if (op.id[1] === state.clock) {
          state.clock++
          yield* this.checkDeleteStoreForState(state)
          yield* this.setState(state)
          var isDeleted = this.store.ds.isDeleted(op.id)

          yield* Y.Struct[op.struct].execute.call(this, op)
          yield* this.addOperation(op)
          yield* this.store.operationAdded(this, op)

          if (isDeleted) {
            yield* Y.Struct['Delete'].execute.call(this, {struct: 'Delete', target: op.id})
          }

          // find next operation to execute
          op = this.store.waitingOperations.find([op.id[0], state.clock])
          if (op != null) {
            this.store.waitingOperations.delete([op.id[0], state.clock])
          }
        } else {
          if (op.id[1] > state.clock) {
            // has to be executed at some point later
            this.store.waitingOperations.add(op)
          }
          op = null
        }
      }
    }
  }
  // called by a transaction when an operation is added
  * operationAdded (transaction, op) {
    var sid = JSON.stringify(op.id)
    var l = this.listenersById[sid]
    delete this.listenersById[sid]

    // notify whenOperation listeners (by id)
    if (l != null) {
      for (var key in l) {
        var listener = l[key]
        if (--listener.missing === 0) {
          this.whenOperationsExist([], listener.op)
        }
      }
    }
    // notify parent, if it has been initialized as a custom type
    var t = this.initializedTypes[JSON.stringify(op.parent)]
    if (t != null && !op.deleted) {
      yield* t._changed(transaction, Y.utils.copyObject(op))
    }
  }
  removeParentListener (id, f) {
    var ls = this.parentListeners[id]
    if (ls != null) {
      this.parentListeners[id] = ls.filter(function (g) {
        return (f !== g)
      })
    }
  }
  addParentListener (id, f) {
    var ls = this.parentListeners[JSON.stringify(id)]
    if (ls == null) {
      ls = []
      this.parentListeners[JSON.stringify(id)] = ls
    }
    ls.push(f)
  }
}
Y.AbstractOperationStore = AbstractOperationStore
