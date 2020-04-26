
require('./utilities.js')

var page_key = '/foo'
g_current_server = null

g_debug_WS_messages = []
g_debug_WS_messages_delayed = []
debug_WS_process_messages = function () {
    while (g_debug_WS_messages.length) {
        g_debug_WS_messages.shift()()
    }
    g_debug_WS_messages = g_debug_WS_messages_delayed
    g_debug_WS_messages_delayed = []
}

debug_WSS = function () {
    return debug_WSS.the_one = {
        on_conns: [],
        on(event_type, func) {
            if (event_type == 'connection') this.on_conns.push(func)
            else throw 'bad'
        },
        ws_array: [],
        close() {
            this.ws_array.forEach(ws =>
                g_debug_WS_messages.push(() => {

                    // console.log(`SERVER CLOSING C-${ws.id}`)

                    ws.onclose && ws.onclose()
                }))
            debug_WSS.the_one = null
        }
    }
}

debug_WS = function (id) {

    // console.log(`C-${id} ATTEMPTING CONNECTING TO SERVER`)

    var self = {
        id,
        on_messages: [],
        on_closes: [],
        is_open: true,
        send(msg) {

            // var m = JSON.parse(msg)
            // console.log(`C-${self.id} SEND: ` + m.method + ' ' + (m.seen || ''))
            // if (m.versions) console.log('versions: ', m.versions)
            // if (m.patches) console.log('version: ', m.version, m.parents, m.patches)

            // console.log(`C-${self.id} SEND: ` + JSON.stringify(JSON.parse(msg), null, '    '))

            this.on_messages.forEach(f =>
                g_debug_WS_messages.push(() => {

                    // console.log(`S RECV from:C-${self.id} : ` + m.method + ' ' + (m.seen || ''))
                    // if (m.versions) console.log('versions: ', m.versions)
                    // if (m.patches) console.log('version: ', m.version, m.parents, m.patches)

                    // if (!self.is_open) console.log('NOT OPEN!')
                    // console.log(`S RECV from:C-${self.id} : ` + JSON.stringify(JSON.parse(msg), null, '    '))
        
                    f(msg)
                }))
        },
        terminate() {
            if (!self.is_open) throw 'closing closed socket'
            self.is_open = false

            // console.log(`CLOSING C-${self.id}`)

            g_debug_WS_messages.push(() =>
                this.onclose && this.onclose())
            this.on_closes.forEach(f =>
                g_debug_WS_messages.push(() => f()))
            this.on_closes = []
            this.on_messages = []
            if (debug_WSS.the_one)
                debug_WSS.the_one.ws_array.splice(debug_WSS.the_one.ws_array.indexOf(self), 1)
        }
    }
    g_debug_WS_messages.push(() => {
        if (debug_WSS.the_one) {
            debug_WSS.the_one.ws_array.push(self)
            debug_WSS.the_one.on_conns.forEach(f => {

                // console.log(`C-${self.id} CONNECTING TO SERVER`)

                f({
                    on(event_type, func) {
                        if (event_type == 'message') self.on_messages.push(func)
                        else if (event_type == 'close') self.on_closes.push(func)
                    },
                    send(msg) {

                        // var m = JSON.parse(msg)
                        // console.log(`S SEND to:C-${self.id} : ` + m.method + ' ' + (m.seen || ''))
                        // if (m.versions) console.log('versions: ', m.versions)
                        // if (m.patches) console.log('version: ', m.version, m.parents, m.patches)

                        // console.log(`S SEND to:C-${self.id} : ` + JSON.stringify(JSON.parse(msg), null, '    '))
    
                        g_debug_WS_messages.push(() => {

                            // console.log(`C-${self.id} RECV: ` + m.method + ' ' + (m.seen || ''))
                            // if (m.versions) console.log('versions: ', m.versions)
                            // if (m.patches) console.log('version: ', m.version, m.parents, m.patches)

                            // if (!self.is_open) console.log('NOT OPEN!')
                            // console.log(`C-${self.id} RECV: ` + JSON.stringify(JSON.parse(msg), null, '    '))
        
                            self.onmessage({data: msg})
                        })
                    }
                })
            })
            self.onopen && self.onopen()
        } else {
            self.onclose && self.onclose()
        }
    })
    return self
}

var ds = require('./diff.js')
const { PerformanceObserver, performance } = require('perf_hooks');

async function main() {
    // var a = '' + require('fs').readFileSync('actions.json')
    // a = JSON.parse(a)
    // run_experiment_from_actions(a)

    // return

    var best_t = Infinity
    var best_seed = null
    var exp_time_est = 1
    var longest = 0
    var longest_seed = null
    var N = 200

    for (var i = 0; i < N; i++) {
        var seed = '__abb__19:' + i


        // N = 1
        // seed = '__ab__7:56'


        console.log('seed: ' + seed)
        var st = performance.now()

        var r = await run_experiment(seed)

        if (!r.ok && r.t < best_t) {
            best_t = r.t
            best_seed = seed
            require('fs').writeFileSync('actions.json', JSON.stringify(r.actions, null, '    '))
        }
        var t = performance.now() - st
        if (t > longest) {
            longest = t
            longest_seed = seed
        }
        exp_time_est = 0.9 * exp_time_est + 0.1 * t
        console.log(`exp_time_est = ${exp_time_est}, t=${t}`)
        console.log(`total time est = ${(exp_time_est * (N - i - 1))/1000/60}min`)
    }
    console.log('best_t = ' + best_t)
    console.log('best_seed = ' + best_seed)
    console.log('longest = ' + longest)
    console.log('longest_seed = ' + longest_seed)
}

async function run_experiment(rand_seed) {
    Math.randomSeed(rand_seed)

    g_debug_WS_messages = []
    g_debug_WS_messages_delayed = []
    debug_WSS.the_one = null

    var trials = 200

    var db = create_db()
    var server = null
    var clients = []

    var log_stuff = false

    var actions = []

    for (var t = 0; t < trials; t++) {
        Date.now = () => t
        var st = performance.now()
        try {
            log_stuff && console.log('----------------------------- trial ' + t)

            if (!server && Math.random() < 0.4) {
                log_stuff && console.log('> starting server')
                actions.push({action: 'starting server', rand: Math.random.get_state()})
                server = create_server(db)
            } else if (server && Math.random() < 0.3) {
                log_stuff && console.log('> closing server')
                actions.push({action: 'closing server', rand: Math.random.get_state()})
                server.close()
                server = null
            } else {
                if (clients.length == 0 || (clients.length < 5 && Math.random() < 0.2)) {
                    log_stuff && console.log('> creating client')
                    actions.push({action: 'creating client', rand: Math.random.get_state()})
                    clients.push(create_client())
                } else {
                    let ci = Math.floor(Math.random() * clients.length)
                    let c = clients[ci]
                    if (!c.is_open && Math.random() < 0.3) {
                        log_stuff && console.log('> re-opening client')
                        actions.push({action: 're-opening client', id: c.id, rand: Math.random.get_state()})
                        c.open()
                    } else if (c.is_open && Math.random() < 0.4) {
                        if (Math.random() < 0.5) {
                            log_stuff && console.log('> closing client (temporarily)')
                            actions.push({action: 'closing client (temporarily)', id: c.id, rand: Math.random.get_state()})
                            c.close(false, false)
                        } else {
                            var send_forget = Math.random() < 0.333
                            var send_deletes = send_forget || Math.random() < 0.5
                            log_stuff && console.log('> killing client' + (send_deletes ? ', sending deletes' : '') + (send_forget ? ', sending forget' : ''))
                            actions.push({action: 'killing client', send_forget, send_deletes, id: c.id, rand: Math.random.get_state()})
                            c.close(send_deletes, send_forget)
                            clients.splice(ci, 1)
                        }
                    } else if (c.is_open) {

                        var inner_actions = []

                        for (let cii = 0; cii < clients.length; cii++) {
                            if (cii == ci || Math.random() < 0.2) {
                                let c = clients[cii]
                                let text = c.get()
                                let start = Math.floor(Math.random() * (text.length + 1))
                                let len = Math.floor(Math.random() * (text.length - start + 1))
                                let ins = String.fromCharCode(65 + Math.floor(Math.random() * 26)).repeat(Math.floor(Math.random() * 4) + (len == 0 ? 1 : 0))
                                log_stuff && console.log(`> C-${c.id} changing text ` + JSON.stringify(text) + `.splice(${start}, ${len}, ${JSON.stringify(ins)})`)
                                inner_actions.push({start, len, ins, id: c.id, rand: Math.random.get_state()})
                                c.set(start, len, ins)
                            }
                        }

                        actions.push({action: 'editing', inner_actions, rand: Math.random.get_state()})
                        
                    } else {
                        log_stuff && console.log('> doing nothing..')
                        actions.push({action: 'doing nothing..'})
                    }
                }
            }

            debug_WS_process_messages()

            log_stuff && console.log(`server: ${server ? `"${server.get()}"` : 'down'}`)
            log_stuff && clients.forEach(c => console.log(`${c.id} client ${c.is_open ? ':' : 'X'} "${c.get()}"`))

            if (true) {
                // console.log('SERVER: ' + (server ? server.get_more() : 'down'))
                // clients.forEach(c => console.log(`CLIENT ${c.id} = ${c.get_more()}`))

                // console.log('SERVER: ' + (g_current_server ? g_current_server.get_null() : 'not started'))
                // clients.forEach(c => console.log(`CLIENT ${c.id} = ${c.get_null()}`))
            }

            if (server && clients.some(c => c.is_open)) {
                let text = server.get()
                if (clients.some(c => c.is_open && c.get() != text)) {
                    console.log('NOT THE SAME!')
                    return {ok: false, t, actions}
                }

                // work here
                let o = server.node.resource_at(page_key).mergeable.read()
                if (!o || !o.cursors || Object.keys(o.cursors).length > clients.length) {
                    console.log('TOO MANY CURSORS!')
                    return {ok: false, t, actions}
                }
            }


            // work here
            if (server) {
                server.node.prune(server.node.resource_at(page_key))
            }


        } catch (e) {
            console.log('EXCEPTION', e)
            return {ok: false, t, actions}
        }
        //actions.push({time: performance.now() - st})
    }
    return {ok: true, actions}
}

async function run_experiment_from_actions(actions) {
    Math.randomSeed('just needed to make set_state available')

    g_debug_WS_messages = []
    g_debug_WS_messages_delayed = []
    debug_WSS.the_one = null

    var db = create_db()
    var server = null
    var clients = []

    var log_stuff = true

    var t = 0
    for (var a of actions) {
        Date.now = () => t

        // console.log('a.action = ' + a.action)

        try {
            log_stuff && console.log('----------------------------- trial ' + t)

            if (a.action == 'starting server') {
                log_stuff && console.log('> starting server')
                Math.random.set_state(a.rand)
                server = create_server(db)
            } else if (a.action == 'closing server') {
                log_stuff && console.log('> closing server')
                Math.random.set_state(a.rand)
                server.close()
                server = null
            } else {
                if (a.action == 'creating client') {
                    log_stuff && console.log('> creating client')
                    Math.random.set_state(a.rand)
                    clients.push(create_client())
                } else {
                    if (a.action == 're-opening client') {
                        log_stuff && console.log('> re-opening client')
                        var c = clients.find(c => c.id == a.id)
                        Math.random.set_state(a.rand)
                        c.open()
                    } else if (a.action == 'closing client (temporarily)') {
                        log_stuff && console.log('> closing client (temporarily)')
                        var c = clients.find(c => c.id == a.id)
                        Math.random.set_state(a.rand)
                        c.close(false)
                    } else if (a.action == 'killing client') {
                        log_stuff && console.log('> killing client' + (a.send_deletes ? ', sending deletes' : '') + (a.send_forget ? ', sending forget' : ''))
                        var c = clients.find(c => c.id == a.id)
                        Math.random.set_state(a.rand)
                        c.close(a.send_deletes, a.send_forget)
                        clients.splice(clients.findIndex(c => c.id == a.id), 1)
                    } else if (a.action == 'editing') {
                        for (let inner_a of a.inner_actions) {
                            let start = inner_a.start
                            let len = inner_a.len
                            let ins = inner_a.ins
                            let c = clients.find(c => c.id == inner_a.id)
                            let text = c.get()
                            log_stuff && console.log(`> C-${c.id} changing text ` + JSON.stringify(text) + `.splice(${start}, ${len}, ${JSON.stringify(ins)})`)
                            Math.random.set_state(inner_a.rand)
                            c.set(start, len, ins)
                        }
                        Math.random.set_state(a.rand)
                    } else if (a.action == 'doing nothing..') {
                        log_stuff && console.log('> doing nothing..')
                    } else throw 'bad'
                }
            }

            debug_WS_process_messages()

            log_stuff && console.log(`server: ${server ? `"${server.get()}"` : 'down'}`)
            log_stuff && clients.forEach(c => console.log(`${c.id} client ${c.is_open ? ':' : 'X'} "${c.get()}"`))


            if (true) {

                console.log('time dags:')
                function show(s) { console.log(JSON.stringify(s.time_dag, null, '    ')) }

                if (g_current_server) show(g_current_server.node.resource_at(page_key))
                clients.forEach(c => show(c.node.resource_at(page_key)))


                // console.log('fissures:')
                // function show2(s) { console.log(JSON.stringify(s.fissures, null, '    ')) }

                // if (g_current_server) show2(g_current_server.node.resource_at(page_key))
                // clients.forEach(c => show2(c.node.resource_at(page_key)))



                // console.log('full versions:')
                // function show(s) { console.log(JSON.stringify(s, null, '    ')) }

                // if (g_current_server) show(g_current_server.node.resource_at(page_key))
                // clients.forEach(c => show(c.node.resource_at(page_key)))

                // console.log('SERVER: ', (g_current_server ? g_current_server.node.resource_at(page_key).mergeable.read() : 'not started'))

                // console.log('SERVER: ' + (g_current_server ? g_current_server.get_time() : 'not started'))
                // clients.forEach(c => console.log(`CLIENT ${c.id} = ${c.get_time()}`))

                // clients.forEach(c => console.log(`CLIENT ${c.id} = ${c.get_more()}`))

                // console.log('null versions:')
                // console.log('SERVER: ', (g_current_server ? g_current_server.get_null() : 'not started'))
                //clients.forEach(c => console.log(`CLIENT ${c.id} = ${c.get_null()}`))

                // if (g_current_server)
                //     console.log('SERVER: ' + JSON.stringify(g_current_server.node.resource_at(page_key), null, '    '))

                // console.log('fissures:')
                // console.log('SERVER: ', (g_current_server ? g_current_server.node.resource_at(page_key).fissures : 'not started'))
            }

            if (server && clients.some(c => c.is_open)) {
                let text = server.get()
                if (clients.some(c => c.is_open && c.get() != text)) {
                    console.log('NOT THE SAME!')
                    return {ok: false, t}
                }


                // work here
                let o = server.node.resource_at(page_key).mergeable.read()
                if (!o || !o.cursors || Object.keys(o.cursors).length > clients.length) {
                    console.log('TOO MANY CURSORS!')
                    return {ok: false, t, actions}
                }

            }



            // work here
            if (server) {
                server.node.prune(server.node.resource_at(page_key))
            }


        } catch (e) {
            console.log('EXCEPTION', e)
            return {ok: false, t}
        }
        t++
    }
    return {ok: true}
}

main()

function create_db() {
    return {
        data: {},
        get(key) { return this.data[key] },
        set(key, val) { this.data[key] = val },
        del(key) { delete this.data[key] }
    }    
}

function create_server(db) {
    var node = require('./store.js')(require('./node.js')(), db)

    node.on_errors.push((key, origin) => {
        // console.log('SERVER ON ERROR')
        node.unbind(key, origin)
    })

    node.fissure_lifetime = 1 // 4
    node.compress()

    var wss = require('./networks/websocket-server.js')(node, {wss: new debug_WSS()})

    return g_current_server = {
        node,
        get() {
            var o = node.resource_at(page_key).mergeable.read()
            return o && o.text
        },
        close() {
            wss.dead = true
            wss.close()
        }
    }
}

function create_client() {
    var node = require('./node.js')()
    node.default(page_key, {cursors: {[node.pid]: {start: 0, end: 0, time: Date.now()}}, text: ''})
    var ws_client = require('./networks/websocket-client.js')({node})

    var cursor_lifetime = 1 // 10000

    var ready = false
    var text = ''
    var selectionStart = 0
    var selectionEnd = 0

    function send_diff(from, to) {
        var v = node.set(page_key, null, ds.diff_convert_to_my_format(ds.diff_main(from, to)).map(x =>
            `.text[${x[0]}:${x[0] + x[1]}] = ${JSON.stringify(x[2])}`
        ))
    }

    function send_cursor_update(start, end) {
        node.set(page_key, null, [`.cursors[${JSON.stringify(node.pid)}] = ${JSON.stringify({start: {type: 'location', path: `.text[${start}]`}, end: {type: 'location', path: `.text[${end}]`}, time: Date.now()})}`])
    }

    var cb = x => {
        ready = true
        text = x.text
        if (x.cursors[node.pid]) {
            selectionStart = x.cursors[node.pid].start
            selectionEnd = x.cursors[node.pid].end
        }
    }
    node.get(page_key, cb)

    node.ons.push((method, args) => {
        if (method != 'welcome' && method != 'fissure') return
        if (args[0].key != page_key) return


        // work here
        // console.log('FISS!!', args)


        var fs = {}
        if (method == 'welcome') {
            for (let f of args[0].fissures)
                fs[`${f.a}:${f.b}:${f.conn}`] = f
        } else {
            let f = args[0].fissure
            fs[`${f.a}:${f.b}:${f.conn}`] = f
        }

        var rest = () => {
            var o = node.resource_at(page_key).mergeable.read()
            if (!o || !o.cursors) return

            Object.assign(fs, node.resource_at(page_key).fissures)
    
            var delete_us = {}
            Object.values(fs).forEach(f => {
                if (!fs[`${f.b}:${f.a}:${f.conn}`]) {
                    if (o.cursors[f.b]) delete_us[f.b] = true
                }
            })

            var now = Date.now()
            Object.entries(o.cursors).forEach(([k, v]) => {
                if (k != node.pid && v.time <= now - cursor_lifetime) delete_us[k] = true
            })


            // work here
            // console.log('FISSer..', delete_us, now, o, cursor_lifetime, node.pid)



            var patches = Object.keys(delete_us).map(k => `delete .cursors[${JSON.stringify(k)}]`)
            if (patches.length) node.set(page_key, null, patches)
        }
        if (method == 'welcome') {
            if (g_debug_WS_messages) g_debug_WS_messages.push(rest)
            else setTimeout(rest, 0)
        } else rest()
    })

    node.on_errors.push((key, origin) => {
        // console.log('CLIENT ON ERROR')

        text = ''
        selectionStart = 0
        selectionEnd = 0

        delete node.resources[key]
        node.unbind(key, origin)

        var subscribe = ws_client.pipe.subscribed_keys[key].we_requested
        delete ws_client.pipe.subscribed_keys[key].we_requested

        ws_client.pipe.send({
            key,
            subscribe,
            method: 'get'
        })
    })

    var self
    return self = {
        id: node.pid,
        node,
        is_open: true,
        get: () => {
            return text
        },
        set: (x, del, ins) => {
            if (!ready) return
            var new_text = text.slice(0, x) + ins + text.slice(x + del)
            send_diff(text, new_text)
            if (x + ins.length <= new_text.length)
                send_cursor_update(x + ins.length, x + ins.length)
            else
                send_cursor_update(new_text.length, new_text.length)
        },
        close: (send_deletes, send_forget) => {
            if (ready && send_deletes) node.set(page_key, null, [`delete .cursors[${JSON.stringify(node.pid)}]`])
            if (send_forget) node.forget(page_key, cb)
            ws_client.disable()
            self.is_open = false
        },
        open: () => {
            ws_client.enable()
            self.is_open = true
        }
    }    
}