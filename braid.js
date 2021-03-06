u = require('./util/utilities.js')
g_show_protocol_errors = false;

module.exports = require.braid = function create_node(node_data = {}) {
    var node = {}
    node.init = (node_data) => {
        node.pid = node_data.pid || u.random_id()
        node.resources = node_data.resources || {}
        for (var key of Object.keys(node.resources)) {
            node.resources[key] = create_resource(node.resources[key])
        }
        if (node_data.fissure_lifetime !== null)
            node.fissure_lifetime = node_data.fissure_lifetime
        if (node.fissure_lifetime === undefined)
            node.fissure_lifetime = 1000 * 60 * 60 * 8  // Default to 8 hours

        node.max_fissures = node_data.max_fissures

        node.defaults = Object.assign(u.dict(), node.defaults || {})
        node.default_patterns = node.default_patterns || []

        node.ons = []
        node.on_errors = []
    
        node.incoming_subscriptions = u.one_to_many()  // Maps `key' to `pipes' subscribed to our key
    }
    node.init(node_data)

    node.resource_at = (key) => {
        if (typeof key !== 'string')
            throw (JSON.stringify(key) + ' is not a key!')
        if (!node.resources[key])
            node.resources[key] = create_resource()

        return node.resources[key]
    }

    function add_full_ack_leaf(resource, version) {

        // G: someone is telling us that "version" is fully (globally) acknowledged,
        // and this fact implies that every ancestor of version is also fully
        // acknowledged, which means that we don't need to keep certain information
        // about them, like "acks_in_process".. this next section simply
        // iterates over all the ancestors (including this version itself) and deletes
        // information we don't need anymore for each one..

        var marks = {}
        function f(v) {
            if (!marks[v]) {
                marks[v] = true
                delete resource.unack_boundary[v]
                delete resource.acked_boundary[v]
                delete resource.acks_in_process[v]
                delete resource.joiners[v]
                Object.keys(resource.time_dag[v]).forEach(f)
            }
        }
        f(version)

        // G: now that old information is gone, we need to add one bit of new
        // information, namely that this version is fully acknowledged,
        // which we express by putting it in the "acked_boundary" (and we hope
        // that nobody calls this function on a version which is already fully
        // acknowledged; you can check the two places where this function is called
        // to verify that they guard against calling this function on a version
        // which is already fully acknowledged.. note that one does so by noting
        // that "acks_in_process" will always be null for versions which are fully
        // acknowledged, because "acks_in_process" is deleted in section above
        // for all such versions)

        resource.acked_boundary[version] = true

        // G: next we're going to prune.. really we could call prune whenever we want,
        // this is just a somewhat reasonable time, since there is some chance
        // that with this new full acknowledgment, that we might be able to prune
        // more stuff than we could prune before (but we could also let the user
        // call "prune" explicitly at their leisure)

        node.prune(resource)
    }
    
    function check_ack_count(key, resource, version) {
        // TODO: could this only take key, instead of key and resource?  Or
        // perhaps a resource should know its key?
        assert(!resource.acks_in_process[version]
               || resource.acks_in_process[version].count >= 0,
               'Acks have gone below zero!',
               {key, version,
                acks_in_process: resource.acks_in_process[version]})

        // G: this function gets called from a couple of places, basically whenever
        // someone suspects that the "count" within "acks_in_process" may have changed,
        // since it might have gone all the way to zero, in which case we will act...
        // of course, in some such instances, acks_in_process may have been removed
        // entirely for a version, so we guard against that here, too..

        if (resource.acks_in_process[version]
            && resource.acks_in_process[version].count == 0) {

            // G: sweet, the count has gone to zero, that means all the acks we were
            // waiting for have arrived, now there are a couple possibilities..

            if (resource.acks_in_process[version].origin) {

                // G: in this case, we have an "origin", which means we didn't create
                // this version ourselves, and "origin" tells us who we first heard
                // about it from, and so now, as per the ack-algorithm, we're going
                // to send an ack back to that person (because the algorithm tells us
                // to only send an ack after we have received acks from everyone
                // we forwarded the information to)

                let p = resource.acks_in_process[version].origin
                p.send && p.send({
                    method: 'ack', key, seen:'local', version,
                    joiner_num: resource.joiners[version]
                })
            } else {

                // G: in this case, we have no "origin", which means we created
                // this version ourselves, and now the fact that all our peers
                // have acknowledged it means that all of their peers have also
                // acknowledged. In fact, everyone in the network must have
                // acknowledged it (or else we would have received a fissure
                // before receiving this acknowledgment, and that fissure would
                // have wiped away "acks_in_process" for this version), so that
                // means this version is "fully (globally) acknowledged",
                // so we'll call add_full_ack_leaf for this version..

                add_full_ack_leaf(resource, version)

                // G: but "add_full_ack_leaf" just modifies our own datastructure,
                // and we must also give the good news to everyone else, so
                // we send a "global" ack to all our peers (and they'll forward it
                // to their peers)

                node.bindings(key).forEach( pipe => {
                    pipe.send && pipe.send({method: 'ack', key, seen:'global', version})
                })
            }
        }
    }

    var default_pipe = {id: 'null-pipe'}

    // Can be called as:
    //  - get(key)
    //  - get(key, cb)
    //  - get({key, origin, ...})
    node.get = (...args) => {
        var key, version, parents, subscribe, origin
        // First rewrite the arguments if called as get(key) or get(key, cb)
        if (typeof args[0] === 'string') {
            key = args[0]
            var cb = args[1]
            origin = (cb
                      ? {id: u.random_id(), send(args) {
                          // We have new data with every 'set' or 'welcome message
                          if ((args.method === 'set' || args.method === 'welcome')
                              && (node.resource_at(key).weve_been_welcomed
                                  // But we only wanna return once we have
                                  // applied any relevant default.  We know
                                  // the default has been applied because
                                  // there will be at least one version.
                                  && !(default_val_for(key)
                                       && !node.current_version(key)))) {

                              // Let's also ensure this doesn't run until
                              // (weve_been_welcomed || zero get handlers are registered)

                              // And if there is a .default out there, then
                              // make sure the state has at least one version
                              // before calling.
                              cb(node.resource_at(key).mergeable.read())}}}
                      : default_pipe)
            if (cb) cb.pipe = origin
        }
        else {
            // Else each parameter is passed explicitly
            ({key, version, parents, subscribe, origin} = args[0])
        }

        // Set defaults
        if (!version)
            // We might default keep_alive to false in a future version
            subscribe = subscribe || {keep_alive: true}

        if (!origin)
            origin = {id: u.random_id()}

        // Sanity-check the input
        {
            function report(x) { g_show_protocol_errors && console.warn('PROTOCOL ERROR for get: ' + x) }
            if (!key || typeof(key) != 'string') { return report('invalid key' + JSON.stringify(key)) }

            log('get:', node.pid, key)

            var resource = node.resource_at(key)
            if (subscribe && subscribe.keep_alive
                && resource.keepalive_peers[origin.id])
                return report('we already welcomed them')

            if (version && typeof(version) != 'string')
                return report('invalid version: ' + JSON.stringify(version))

            if (parents && (typeof(parents) != 'object'
                            || Object.entries(parents).some(([k, v]) => v !== true)))
                return report('invalid parents: ' + JSON.stringify(parents))
        }

        node.ons.forEach(on => on('get', {key, version, parents, subscribe, origin}))

        // Now record this subscription to the bus
        node.incoming_subscriptions.add(key, origin.id, origin)
        // ...and bind the origin pipe to future sets
        node.bind(key, origin)

        // If this is the first subscription, fire the .on_get handlers
        if (node.incoming_subscriptions.count(key) === 1) {
            log('node.get:', node.pid, 'firing .on_get for',
                node.bindings(key).length, 'pipes!')
            // This one is getting called afterward
            node.bindings(key).forEach(pipe => {

                var best_t = -Infinity
                var best_parents = null
                Object.values(node.resource_at(key).fissures).forEach(f => {
                    if (f.a == node.pid && f.b == pipe.remote_peer && f.time > best_t) {
                        best_t = f.time
                        best_parents = f.versions
                    }
                })

                pipe.send && pipe.send({
                    method:'get', key, version, parents: best_parents, subscribe
                })
            })
        }

        // G: now if the person connecting with us wants to be a citizen, they'll
        // set "pid", and we'll want to send them a "get" as well so that we
        // can learn about their updates -- of course, when they get that get,
        // we don't want an echo war of gets begetting gets, so when someone sends
        // the initial get, they set "initial" to true, but we respond with a get
        // with initial not set to true

        // if (origin.them && initial)
        //     origin.send({method: 'get', key, initial: false})

        // G: ok, now if we're going to be sending this person updates,
        // we should start by catching them up to our current state,
        // which we'll do by sending a "welcome". "generate_braid" calculates
        // the versions comprising this welcome (we need to calculate them because
        // we store the versions inside a space dag, and we need to pull them out...
        // note that it wouldn't work to just keep the versions around on the side,
        // because we also prune the space dag, meaning that the versions generated
        // here may be different than the version we originally received, though
        // hopefully no versions already known to this incoming peer will have been
        // modified, or if they have been, hopefully those versions are deep enough
        // in the incoming peer's version dag that they are not the direct parents
        // of any new edits made by them... we strive to enforce this fact with
        // the pruning algorithm)

        var welcome_msg = node.create_welcome_message(key, parents)

        // Remember this subscription from origin so that we can fissure if
        // our connection to origin breaks
        if (u.has_keep_alive(origin, key))
            resource.keepalive_peers[origin.id] = {
                id: origin.id,
                connection: origin.connection,
                remote_peer: origin.remote_peer
            }

        // G: ok, here we actually send out the welcome

        origin.send && origin.send(welcome_msg)

        return resource.mergeable.read(version)
    }

    node.create_welcome_message = (key, parents) => {
        var resource = node.resource_at(key)
        if (parents && Object.keys(parents).length) {
            var anc = resource.ancestors(parents, true)
        } else { var anc = {} }
        var versions = resource.mergeable.generate_braid(x => anc[x])
        versions = JSON.parse(JSON.stringify(versions))

        versions.forEach(x => {
            // we want to put some of this stuff in a "hint" field,
            // as per the protocol
            if (x.sort_keys) {
                x.hint = {sort_keys: x.sort_keys}
                delete x.sort_keys
            }
        })

        // G: oh yes, we also send them all of our fissures, so they can know to keep
        // those versions alive

        var fissures = Object.values(resource.fissures)

        // here we are setting "parents" equal to the leaves of "anc"
        parents = resource.get_leaves(anc)
        
        return {method: 'welcome', key, versions, fissures, parents}
    }
    
    node.error = ({key, type, in_response_to, origin}) => {
        node.on_errors.forEach(f => f(key, origin))
    }

    // Can be called as:
    //  - set(key, val)                     // Set key to val
    //  - set(key, null, '= "foo"')         // Patch with a patch
    //  - set(key, null, ['= "foo"', ...])  // Patch with multiple patches
    //  - set({key, patches, origin, ...})
    node.set = (...args) => {
        var key, patches, version, parents, origin, joiner_num

        // First rewrite the arguments if called as set(key, ...)
        if (typeof args[0] === 'string') {
            key = args[0]
            patches = args[2]
            if (typeof patches === 'string')
                patches = [patches]
            if (!patches)
                patches = ['= ' + JSON.stringify(args[1])]
        }
        else {
            // Else each parameter is passed explicitly
            ({key, patches, version, parents, origin, joiner_num} = args[0])
        }

        // Sanity-check the input
        {
            function report(x) {
                g_show_protocol_errors && console.warn('PROTOCOL ERROR for set: ' + x)
            }

            if (!key || typeof(key) != 'string')
                return report('invalid key: ' + JSON.stringify(key))

            var resource = node.resource_at(key)

            // If you're trying to join a persistent consistent group, then
            // you probably don't want to send any SETs before you actually
            // join and know what the current version is:
            if (origin && u.has_keep_alive(origin, key)
                && !resource.keepalive_peers[origin.id])
                return report('we did not welcome them yet')

            if (!patches || !Array.isArray(patches)
                || patches.some(x => typeof(x) != 'string'))
                return report('invalid patches: ' + JSON.stringify(patches))

            if (!version) version = u.random_id()
            if (!version || typeof(version) != 'string')
                report('invalid version: ' + JSON.stringify(version))

            if (!parents) parents = {...resource.current_version}
            if (parents && (typeof(parents) != 'object'
                            || Object.entries(parents).some(([k, v]) => v !== true)))
                return report('invalid parents: ' + JSON.stringify(parents))

            if (typeof(joiner_num) != 'undefined' && typeof(joiner_num) != 'number')
                return report('invalid joiner_num: ' + JSON.stringify(joiner_num))
        }

        log('set:', {key, version, parents, patches, origin, joiner_num})

        for (p in parents) {
            if (!resource.time_dag[p]) {
                // Todo: make this work with origin == null
                origin && origin.send && origin.send({
                    method: 'error',
                    key,
                    type: 'cannot merge: missing parents',
                    in_response_to: {
                        method: 'set',
                        key, patches, version, parents, joiner_num
                    }
                })
                node.on_errors.forEach(f => f(key, origin))
                return                    
            }
        }

        node.ons.forEach(on => on('set', {key, patches, version, parents, origin, joiner_num}))

        // G: cool, someone is giving us a new version to add to our datastructure.
        // it might seem like we would just go ahead and add it, but instead
        // we only add it under certain conditions, namely one of the following
        // must be true:
        //
        // !origin : in this case there is no origin, meaning the version was
        // created locally, so we definitely want to add it.
        //
        // !resource.time_dag[version] : in this case the version must have come
        // from someone else (or !origin would be true), but we don't have
        // the version ourselves (otherwise it would be inside our time_dag),
        // so we want to add this new version we haven't seen before.
        //
        // (joiner_num > resource.joiners[version]) : even if we already have
        // this version, we might want to, in some sense, add it again,
        // in the very special case where this version is a joiner,
        // and its joiner_num is bigger than the version of this joiner that we
        // already have.. the issue with joiners is that they can be created
        // on multiple peers simultaneously, and they share the same version id,
        // and in that case, it would be unclear who should send the "global"
        // acknowledgment for the joiner, so we use this "joiner_num" to
        // distinguish the otherwise identical looking joiners for the purposes
        // of electing a particular joiner to handle the full acknowledgment.

        if (!origin                                         // Was created locally
            || !resource.time_dag[version]                  // We don't have it yet
            || (joiner_num > resource.joiners[version])) {  // It's a dominant joiner

            // console.log('Branch •A• happened')

            // G: so we're going to go ahead and add this version to our
            // datastructure, step 1 is to call "add_version" on the underlying
            // mergeable..

            // console.log('Adding version', {version, parents, patches},
            //             'to', Object.keys(resource.time_dag))
            resource.mergeable.add_version(version, parents, patches)

            // G: next, we want to remember some information for the purposes
            // of acknowledgments, namely, we'll remember how many people
            // we forward this version along to (we'll actually do the forwarding
            // right after this), and we also remember whether or not
            // we are the originators of this version (if we originated the version,
            // then we'll be responsible for sending the "global" ack when
            // the time is right)..

            var origin_is_keepalive = origin && resource.keepalive_peers[origin.id]
            resource.acks_in_process[version] = {
                origin: origin_is_keepalive && origin,
                count: Object.keys(resource.keepalive_peers).length
            }
            if (origin_is_keepalive)
                // If the origin is a keepalive_peer, then since we've already
                // seen it from them, we can decrement count
                resource.acks_in_process[version].count--

            assert(resource.acks_in_process[version].count >= 0,
                   node.pid, 'Acks have below zero! Proof:',
                   {origin, key, version,
                    acks_in_process: resource.acks_in_process[version]})

            // console.log('Initialized acks to', resource.acks_in_process[version])
            
            // G: well, I said forwarding the version would be next, but here
            // is this line of code to remember the joiner_num of this
            // version, in case it is a joiner (we store the joiner_num for
            // each version in a auxiliary hashmap called joiners)..

            if (joiner_num) resource.joiners[version] = joiner_num

            // G: and now for the forwarding of the version to all our peers,
            // (unless we received this "set" from one of our peers,
            // in which case we don't want to send it back to them)

            log('set: broadcasting to',
                node.bindings(key)
                   .filter(p => p.send && (!origin || p.id !== origin.id))
                   .map   (p => p.id),
                'pipes from', origin && origin.id)
            // console.log('Now gonna send a set on', node.bindings(key))
            node.bindings(key).forEach(pipe => {
                if (pipe.send && (!origin || (pipe.id !== origin.id))) {
                    log('set: sending now from', node.pid, pipe.type)
                    pipe.send({method: 'set',
                               key, patches, version, parents, joiner_num})
                }
            })
            
        } else if (resource.acks_in_process[version]
                   // Greg: In what situation is acks_in_process[version] false?

                   // G: good question; the answer is that in some cases
                   // we will delete acks_in_process for a version if,
                   // say, we receive a global ack for a descendant of this version,
                   // or if we receive a fissure.. in such cases, we simply
                   // ignore the ack process for that version, and rely
                   // on a descendant version getting globally acknowledged.

                   && joiner_num == resource.joiners[version])

            // G: now if we're not going to add the version, most commonly because
            // we already possess the version, there is another situation that
            // can arise, namely, someone that we forwarded the version to
            // sends it back to us... How could that happen? Well, they may have
            // heard about this version from someone we sent it to, before
            // hearing about it from us (assuming some pretty gross latency)..
            // anyway, if it happens, we can treat it like an ACK for the version,
            // which is why we decrement "count" for acks_in_process for this version;
            // a similar line of code exists inside "node.ack"

            // console.log('Branch •B• happened',
            //             joiner_num,
            //             resource.joiners[version],
            //             resource.acks_in_process[version].count)

            resource.acks_in_process[version].count--

        // G: since we may have messed with the ack count, we check it
        // to see if it has gone to 0, and if it has, take the appropriate action
        // (which is probably to send a global ack)


        check_ack_count(key, resource, version)
        return version
    }
    node.set_patch = node.setPatch = (key, patch) => node.set({key, patches: [patch]})

    // Todo:
    //  - Rename min_leaves and unack_boundary to unack_from and unack_to
    node.welcome = ({key, versions, fissures, unack_boundary, min_leaves, parents, origin}) => {
        // Sanity-check the input
        {
            function report(x) {
                g_show_protocol_errors && console.warn('PROTOCOL ERROR for welcome: '+x)
            }
            if (!key || typeof(key) != 'string')
                return report('invalid key: ' + JSON.stringify(key))

            var resource = node.resource_at(key)
            if (!resource.keepalive_peers[origin.id])
                return report('we did not welcome them yet')

            if (!Array.isArray(versions) || !versions.every(v => {
                if (v.version && typeof(v.version) != 'string') return false
                if (!v.parents || typeof(v.parents) != 'object'
                    || Object.entries(v.parents).some(([k, v]) => v !== true)) return false
                if (!Array.isArray(v.changes)
                    || v.changes.some(x => typeof(x) != 'string')) return false
                if (v.hint) {
                    if (!v.hint.sort_keys) return false
                    if (typeof(v.hint.sort_keys) != 'object') return false
                    if (!Object.entries(v.hint.sort_keys).every(([index, key]) => (''+index).match(/^\d+$/) && typeof(key) == 'string')) return false
                }
                return true
            })) { return report('invalid versions: ' + JSON.stringify(versions)) }

            if (!Array.isArray(fissures) || !fissures.every(fissure => {
                if (!fissure || typeof(fissure) != 'object') return false
                if (typeof(fissure.a) != 'string') return false
                if (typeof(fissure.b) != 'string') return false
                if (typeof(fissure.conn) != 'string') return false
                if (!fissure.versions || typeof(fissure.versions) != 'object'
                    || !Object.entries(fissure.versions).every(([k, v]) => v === true)) return false
                if (!fissure.parents || typeof(fissure.parents) != 'object'
                    || !Object.entries(fissure.parents).every(([k, v]) => v === true)) return false
                if (typeof(fissure.time) != 'number') return false
                return true
            })) { return report('invalid fissures: ' + JSON.stringify(fissures)) }

            if (unack_boundary && (typeof(unack_boundary) != 'object'
                                   || !Object.entries(unack_boundary).every(
                                       ([k, v]) => v === true)))
                return report('invalid unack_boundary: '+JSON.stringify(unack_boundary))

            if (min_leaves && (typeof(min_leaves) != 'object'
                               || !Object.entries(min_leaves).every(
                                   ([k, v]) => v === true)))
                return report('invalid min_leaves: ' + JSON.stringify(min_leaves))
            
            if (parents && (typeof(parents) != 'object'
                               || !Object.entries(parents).every(
                                   ([k, v]) => v === true)))
                return report('invalid parents: ' + JSON.stringify(parents))
        }

        // let people know about the welcome
        node.ons.forEach(on => on('welcome', {key, versions, fissures, unack_boundary, min_leaves, origin}))

        // `versions` is actually array of set messages. Each one has a version.
        var new_versions = []
        
        // G: Some of the incoming versions we may already have.
        // So one might ask, why don't we just filter the versions
        // according to which ones we already have? why this versions_T
        // nonsense? The issue is that there may be versions which
        // we don't have, but that we don't want to add either,
        // presumably because we pruned them, and this code seeks
        // to filter out such versions. The basic strategy is that
        // for each incoming version, if we already have that version,
        // not only do we want to not add it, but we don't want
        // to add any incoming ancestors of that version either (because
        // we must already have them, or else we did have them,
        // and pruned them)

        var versions_T = {}
        versions.forEach(v => versions_T[v.version] = v.parents)
        versions.forEach(v => {
            if (resource.time_dag[v.version]) {
                function f(v) {
                    if (versions_T[v]) {
                        Object.keys(versions_T[v]).forEach(f)
                        delete versions_T[v]
                    }
                }
                f(v.version)
            }
        })

        // G: now versions_T will only contain truthy values for versions
        // which we really do want to add (they are new to us, and they
        // are not repeats of some version we had in the past, but pruned away)

        for (var v of versions) {
            if (versions_T[v.version]) {
                new_versions.push(v)

                if (!Object.keys(v.parents).every(p => resource.time_dag[p])) return send_error()

                resource.mergeable.add_version(v.version, v.parents, v.changes, v.hint && v.hint.sort_keys)
            }
        }

        function send_error() {
            origin.send && origin.send({
                method: 'error',
                key,
                type: 'cannot merge: missing necessary versions',
                in_response_to: {
                    method: 'welcome',
                    key, versions, fissures, unack_boundary, min_leaves
                }
            })
            node.on_errors.forEach(f => f(key, origin))
        }

        // let's also check to make sure we have the min_leaves and unack_boundary,
        // if they are specified..
        if (((min_leaves && Object.keys(min_leaves).some(k => !resource.time_dag[k]))
             || (unack_boundary && Object.keys(unack_boundary).some(k => !resource.time_dag[k]))))
            return send_error()
        
        // G: next we process the incoming fissures, and like before,
        // we only want to add new ones, and there's also this gen_fissures
        // variable which is short of "generated_fissures", and records
        // fissures which we created just now as part of a special case
        // where we receive a fissure that we were supposedly involved with,
        // but we don't have a fissure record for (this can happen when someone
        // tries to connect with us, but the connection is broken even before
        // we knew they were trying to connect)

        var new_fissures = []
        var gen_fissures = []
        fissures.forEach(f => {
            var key = f.a + ':' + f.b + ':' + f.conn
            if (!resource.fissures[key]) {

                // G: so we don't have this fissure.. let's add it..

                new_fissures.push(f)
                resource.fissures[key] = f

                // G: now let's check for that special case where we don't
                // have the fissure, but we're one of the ends of the fissure
                // (note that we don't check for f.a == node.pid because that
                // would be a fissure created by us -- we're looking for
                // fissures not created by us, but that we are the other end
                // of).  We just add these fissures to gen_fissures for now,
                // and later in this function we'll iterate over gen_fissures
                // and actually add these fissures to our data structure (as
                // well as tell them to our peers)
                //
                // If we don't do this, then this fissure will never get pruned,
                // because it will never find its "other half"

                if (f.b == node.pid) gen_fissures.push({
                    a:        node.pid,
                    b:        f.a,
                    conn:     f.conn,
                    versions: f.versions,
                    parents:  {},
                    time:     f.time
                })
            }
        })

        // G: there is this thing called the unack_boundary, which defines
        // a set of nodes (namely everything on the boundary, and any ancestors
        // of anything on the boundary), and these nodes should exhibit the
        // behavior that even if a global acknowledgment is received for them,
        // it should be ignored.
        //
        // why should we ignore them? well, this welcome message we've received
        // is kindof like an anti-fissure -- it is a new citizen in the network,
        // and the whole idea of a "global ack" is that all citizens connected
        // directly or transitively to ourselves have seen this version,
        // but imagine that there is a "global ack" sitting the our message queue,
        // but it was created before this new connection, meaning that it's
        // claim has been violated (in particular, this new citizen may not
        // have seen the version, and this new citizen may bring in transitive
        // access to even more citizens, which also may not have seen the version),
        // so rather than trying to figure out who has seen what when a new
        // connection is established, we sortof blacklist global acknowledgments
        // for all versions in both our, and the new citizens current versions,
        // and we wait for a version created after this connection event
        // to get globally acknowledged (note that this involves un-globally
        // acknowledging things that we had thought were globally acknowledged,
        // but not everything -- if a version is globally acknowledged by us,
        // and also by the incoming citizen, then we keep that version as
        // globally acknowledged)

        // G: this next if statement deals with two cases of the welcome message.
        // in one case, the welcome is sent as a response to a get,
        // in which case unack_boundary is null (and you can see that we just
        // set it to be absolutely all of the versions we currently know about,
        // both in our own version set, and the incoming version set, since
        // we already added the incoming versions to our set). If it isn't null,
        // then we don't need to give it a value here (and this message must be
        // a case of propoagating a welcome around the network)
        //
        // So conceptually, we establish the unack_boundary on the initial
        // welcome (and we can't know it before then, because the person
        // sending us this welcome doesn't know which versions we have),
        // and then once it is established, we hardcode the result into
        // the welcome messages that we send to our peers

        if (!unack_boundary)
            unack_boundary = Object.assign({}, resource.current_version)

        // G: to understand this next bit of code,
        // first know that these "boundary" variables are really just
        // trying to be more effecient ways of storing sets of versions (which
        // include everything on the boundary, as well as all the ancestors
        // of those versions). If we were using sets, our code would
        // be doing this:
        //
        // resource.unack_set = union(resource.unack_set, unack_set)
        //
        // that is, we want to union our pre-existing unacked stuff with
        // the new incoming unacked stuff. But since our implementation
        // uses boundaries rather than sets, we get the code that follows
        // (you can see that the only modifications being made are to
        // resource.unack_boundary, where we delete some stuff, and add
        // some stuff, so that it represents the new boundary)

        // console.log('processing1:', resource.unack_boundary)
        var our_conn_versions = resource.ancestors(resource.unack_boundary)
        // console.log('processing2:', unack_boundary)

        var new_conn_versions = resource.ancestors(unack_boundary)

        Object.keys(resource.unack_boundary).forEach(x => {
            if (new_conn_versions[x] && !unack_boundary[x]) {
                delete resource.unack_boundary[x]
            }
        })
        Object.keys(unack_boundary).forEach(x => {
            if (!our_conn_versions[x]) resource.unack_boundary[x] = true
        })

        // G: so that was dealing with the unack_boundary stuff... now
        // we want to deal with the globally acknowledged stuff. Basically,
        // anything that is globally acknowledged by both us, and the incoming
        // citizen, will remain globally acknowledged. We'll compute these
        // versions as the intersection of ours and their acknowledged set,
        // and then store just the boundary of the intersection set
        // and call it "min_leaves" (where "min" basically means "intersection"
        // in this case, and used to be paired with "max_leaves", which
        // meant "union", and was used to represent the unack_boundary above)
        //
        // As before, min_leaves will be null on the initial welcome,
        // and we'll compute it, and then subsequent welcomes will have this
        // result included...
        
        if (!min_leaves) {
            min_leaves = parents ? {...parents} : {}
            versions.forEach(v => {
                if (!versions_T[v.version]) min_leaves[v.version] = true
            })
            min_leaves = resource.get_leaves(resource.ancestors(min_leaves, true))
        }

        // G: we are now armed with this "min_leaves" variable,
        // either because we computed it, or it was given to us...
        // what do we do with it? well, we want to roll-back our
        // boundary of globally acknowledged stuff so that it only
        // includes stuff within "min_leaves" (that is, we only want
        // to keep stuff as globally acknowledged if it was already
        // globally acknowledged, and also it is already known to this
        // incoming citizen)
        //
        // As before, we're really doing a set intersection (in this case
        // an intersection between min_leaves and our own acked_boundary),
        // but the code looks wonkier because all our variables store
        // the boundaries of sets, rather than the sets themselves

        var min_versions = resource.ancestors(min_leaves)
        var ack_versions = resource.ancestors(resource.acked_boundary)
        Object.keys(resource.acked_boundary).forEach(x => {
            if (!min_versions[x])
                delete resource.acked_boundary[x]
        })
        Object.keys(min_leaves).forEach(x => {
            if (ack_versions[x]) resource.acked_boundary[x] = true
        })

        // G: this next line of code is pretty drastic.. it says: "If we're
        // connecting to someone new, then all our hard work keeping track
        // of acknowledgments is now useless, since it relies on an algorithm
        // that assumes there will be no changes in the network topology
        // whilst the algorithm is being carried out -- and the network topology
        // just changed, because now there's this new guy"
        //
        // Fortunately, once a new version is globally acknowledged within the new
        // topology, it's acknowledgment will extend to these versions as well,
        // because global acknowledgments apply to all ancestors of a version,
        // and any new versions will include all existing versions as ancestors.
        
        resource.acks_in_process = {}

        // G: ok, we're pretty much done. We've made all the changes to our
        // own data structure (except for the gen_fissures, which will happen next),
        // and now we're ready to propogate the information to our peers.
        //
        // So, up above, when we added new versions and fissures to ourselves,
        // we marked each such instance in new_versions or new_fissures,
        // and if we got any new versions or fissures, then we want to
        // tell our peers about it (if we didn't, then we don't need to tell anyone,
        // since there's nothing new to hear about)
        
        assert(unack_boundary && min_leaves && fissures && new_versions)
        if (new_versions.length > 0 || new_fissures.length > 0 || !resource.weve_been_welcomed) {
            // Now record that we've seen a welcome
            resource.weve_been_welcomed = true

            // And tell everyone about it!
            node.bindings(key).forEach(pipe => {
                if (pipe.send && (pipe.id !== origin.id))
                    pipe.send({method: 'welcome',
                               key, versions: new_versions, unack_boundary, min_leaves,
                               fissures: new_fissures})
            })
        }

        // G: now we finally add the fissures we decided we need to create
        // in gen_fissures... we add them now, after the code above,
        // so that these network messages appear after the welcome (since
        // they may rely on information which is in the welcome for other
        // people to understand them)

        gen_fissures.forEach(f => node.fissure({key, fissure:f}))

        // Now that we processed the welcome, set defaults if we have one
        var default_val = default_val_for(key)
        if (default_val && !node.current_version(key)) {
            node.set({key, patches: [` = ${JSON.stringify(default_val)}`], version: 'default_version', parents: {}})
        }
    }
    
    // Can be called as:
    //  - forget(key, cb), with the same cb passed to get(key, cb)
    //  - forget({key, origin})
    node.forget = (...args) => {
        var key, origin, cb
        if (typeof(args[0]) === 'string') {
            key = args[0]
            cb = args[1]
            origin = cb.pipe
        } else {
            ({key, origin} = args[0])
        }

        // guard against invalid forgets
        if (true) {
            function report(x) {
                g_show_protocol_errors && console.warn('PROTOCOL ERROR for forget: '+x)
            }
            log(`forget: ${node.pid}, ${key}->${origin.id}`)
            if (!key || typeof(key) != 'string')
                return report('invalid key: ' + JSON.stringify(key))
            if (!node.incoming_subscriptions.has(key, origin.id))
                return report(`pipe "${origin.id}" did not get the key "${key}" yet`)
        }

        node.ons.forEach(on => on('forget', {key, origin}))

        var resource = node.resource_at(key)
        delete resource.keepalive_peers[origin.id]
        node.unbind(key, origin)
        node.incoming_subscriptions.delete(key, origin.id)

        // todo: what are the correct conditions to send the forget?
        // for now, we just support the hub-spoke model, where only clients
        // send forget.
        // here is what the todo said before:
        // TODO: if this is the last subscription, send forget to all gets_out
        // origin.send({method: 'forget', key})
        if (cb && node.incoming_subscriptions.count(key) == 0) {
            node.bindings(key).forEach(pipe => {
                pipe.send && pipe.send({
                    method:'forget', key, origin
                })
            })
        }
    }

    node.ack = ({key, valid, seen, version, origin, joiner_num}) => {
        // guard against invalid messages
        if (true) {
            function report(x) {
                g_show_protocol_errors && console.warn('PROTOCOL ERROR for ack: ' + x)
            }
            if (typeof(key) != 'string')
                return report('invalid key: ' + JSON.stringify(key))

            var resource = node.resource_at(key)
            if (!resource.keepalive_peers[origin.id])
                return report('we did not welcome them yet')

            if (typeof(valid) != 'undefined')
                return report('support for valid flag not yet implemented')

            if (seen != 'local' && seen != 'global')
                return report('invalid seen: ' + JSON.stringify(seen))

            if (typeof(version) != 'string')
                return report('invalid version: ' + JSON.stringify(version))

            if (typeof(joiner_num) != 'undefined' && typeof(joiner_num) != 'number')
                return report('invalid joiner_num: ' + JSON.stringify(joiner_num))
        }

        node.ons.forEach(on => on('ack', {key, valid, seen, version, origin, joiner_num}))

        log('node.ack: Acking!!!!', {key, seen, version, origin})

        if (seen == 'local') {
            if (resource.acks_in_process[version]
                && (joiner_num == resource.joiners[version])) {
                log('node.ack: Got a local ack! Decrement count to',
                    resource.acks_in_process[version].count - 1)
                resource.acks_in_process[version].count--
                check_ack_count(key, resource, version)
            }
        } else if (seen == 'global') {
            if (!resource.time_dag[version]) return
            
            var ancs = resource.ancestors(resource.unack_boundary)
            if (ancs[version]) return
            
            ancs = resource.ancestors(resource.acked_boundary)
            if (ancs[version]) return
            
            add_full_ack_leaf(resource, version)
            node.bindings(key).forEach(pipe => {
                if (pipe.send && (pipe.id != origin.id))
                    pipe.send({method: 'ack', key, version, seen: 'global'})
            })
        }
    }
    
    node.fissure = ({key, fissure, origin}) => {
        // guard against invalid messages
        if (true) {
            function report(x) { g_show_protocol_errors && console.warn('PROTOCOL ERROR for fissure: ' + x) }
            if (typeof(key) != 'string') { return report('invalid key: ' + JSON.stringify(key)) }

            var resource = node.resource_at(key)

            if ((!fissure || typeof(fissure) != 'object') ||
                (!fissure.a || typeof(fissure.a) != 'string') ||
                (!fissure.b || typeof(fissure.b) != 'string') ||
                (!fissure.conn || typeof(fissure.conn) != 'string') ||
                (!fissure.versions || typeof(fissure.versions) != 'object' || !Object.entries(fissure.versions).every(([k, v]) => v === true)) ||
                (!fissure.parents || typeof(fissure.parents) != 'object' || !Object.entries(fissure.parents).every(([k, v]) => v === true)) ||
                (typeof(fissure.time) != 'number')
            ) { 
                return report('invalid fissure: ' + JSON.stringify(fissure))
            }
        }

        node.ons.forEach(on => on('fissure', {key, fissure, origin}))

        var fkey = fissure.a + ':' + fissure.b + ':' + fissure.conn
        if (!resource.fissures[fkey]) {
            resource.fissures[fkey] = fissure
            
            resource.acks_in_process = {}
            
            // First forward this fissure along
            node.bindings(key).forEach(pipe => {
                if (pipe.send && (!origin || (pipe.id != origin.id)))
                    pipe.send({method: 'fissure',
                               key,
                               fissure})
            })
            
            // And if this fissure matches us, then send the anti-fissure for
            // it
            if (fissure.b == node.pid)
                node.fissure({key,
                              fissure: {
                                  a:        node.pid,
                                  b:        fissure.a,
                                  conn:     fissure.conn,
                                  versions: fissure.versions,
                                  parents:  {},
                                  time:     fissure.time
                              }
                             })
        }
    }

    node.disconnected = ({key, name, versions, parents, time, origin}) => {
        // Todo:
        //  - rename "name" to "fissure".
        //  - rename "time" to "disconnect_time"
        if (time == null) time = Date.now()
        node.ons.forEach(on => on('disconnected', {key, name, versions, parents, time, origin}))

        // unbind them (but only if they are bound)
        if (node.bindings(key).some(p => p.id == origin.id)) node.unbind(key, origin)

        // if we haven't sent them a welcome (or they are not remote), then no
        // need to create a fissure
        if (!origin.remote_peer|| !node.resource_at(key).keepalive_peers[origin.id]) return
        
        // now since we're disconnecting, we reset the keepalive_peers flag
        delete node.resource_at(key).keepalive_peers[origin.id]

        assert(key && origin)
        // To do:
        //  - make this work for read-only connections
        //  - make this work for multiple keys (a disconnection should
        //    affect all of its keys)
        var resource = node.resource_at(key),
            fissure

        assert(!(name || versions || parents), 'Surprise!')

        // Generate the fissure
        if (name) {
            // Create fissure from name
            var [a, b, conn] = name.split(/:/)
            fissure = {
                a, b, conn,
                versions,
                parents,
                time
            }
        } else {
            // Create fissure from scratch

            // assert(resource.subscriptions[origin.id],
            //        `This pipe ${origin.id} is not on the resource for ${node.pid}'s ${key}`,
            //        resource.subscriptions)
            
            assert(origin.id,          'Need id on the origin', origin)
            assert(origin.remote_peer, 'Need a peer on origin', origin)

            var versions = {}
            var ack_versions = resource.ancestors(resource.acked_boundary)
            Object.keys(resource.time_dag).forEach(v => {
                if (!ack_versions[v] || resource.acked_boundary[v])
                    versions[v] = true
            })
            
            var parents = {}
            Object.keys(resource.fissures).forEach(x => parents[x] = true )
            
            fissure = {
                a: node.pid,
                b: origin.remote_peer,
                conn: origin.connection,
                versions,
                parents,
                time
            }

        }

        node.fissure({key, origin, fissure})
    }
    
    node.delete = () => {
        // NOT IMPLEMENTED: idea: use "undefined" to represent deletion
        // update: we now have a {type: "deleted"} thing (like {type: "location"}),
        // may be useful for this
    }

    node.current_version = (key) =>
        Object.keys(node.resource_at(key).current_version).join('-') || null
    node.versions = (key) => Object.keys(node.resource_at(key).time_dag)
    node.fissures = (key) => Object.values(node.resource_at(key).fissures).map(
        fiss => ({ ...fiss,
                   // Reformat `versions` and `parents` as arrays
                   parents:  Object.keys(fiss.parents),
                   versions: Object.keys(fiss.versions) }))
    node.unmatched_fissures = (key) => {
        var result = []
        var fissures = node.resource_at(key).fissures
        outer_loop:
        for (fiss in fissures) {
            for (fiss2 in fissures) {
                if (   fissures[fiss].conn === fissures[fiss2].conn
                    && fissures[fiss].a    === fissures[fiss2].b
                    && fissures[fiss].b    === fissures[fiss2].a)
                    continue outer_loop
            }
            fiss = fissures[fiss]
            result.push({...fiss,
                         // Reformat `versions` and `parents` as arrays
                         parents:  Object.keys(fiss.parents),
                         versions: Object.keys(fiss.versions)})
        }
        return result
    }

    node.prune = (resource) => {
        var unremovable = {}

        // First, let's prune old fissures

        // Calculate which fissures we have to keep due to parenting
        // rule... which we will be removing soon.
        Object.entries(resource.fissures).forEach(x => {
            if (!resource.fissures[x[1].b + ':' + x[1].a + ':' + x[1].conn]) {
                function f(y) {
                    if (!unremovable[y.a + ':' + y.b + ':' + y.conn]) {
                        unremovable[y.a + ':' + y.b + ':' + y.conn] = true
                        unremovable[y.b + ':' + y.a + ':' + y.conn] = true
                        Object.keys(y.parents).forEach(p => {
                            if (resource.fissures[p]) f(resource.fissures[p])
                        })
                    }
                }
                f(x[1])
            }
        })
        
        // Now remove the fissures
        Object.entries(resource.fissures).forEach(x => {
            var other_key = x[1].b + ':' + x[1].a + ':' + x[1].conn
            var other = resource.fissures[other_key]
            if (other) {
                if (unremovable[x[0]]) {
                    resource.fissures[x[0]].versions = {}
                    resource.fissures[other_key].versions = {}
                } else {
                    delete resource.fissures[x[0]]
                    delete resource.fissures[other_key]
                }
            }
        })

        // Remove fissures that have expired due to time
        if (node.fissure_lifetime != null) {
            var now = Date.now()
            Object.entries(resource.fissures).forEach(([k, f]) => {
                if (f.time == null) f.time = now
                if (f.time <= now - node.fissure_lifetime) {
                    delete resource.fissures[k]
                }
            })
        }

        // Remove fissures that are beyond our max_fissures limit
        if (node.max_fissures != null) {
            let count = Object.keys(resource.fissures).length
            if (count > node.max_fissures) {
                Object.entries(resource.fissures).sort((a, b) => {
                    if (a[1].time == null) a[1].time = now
                    if (b[1].time == null) b[1].time = now
                    return a[1].time - b[1].time
                }).slice(0, count - node.max_fissures).forEach(e => {
                    delete resource.fissures[e[0]]
                })
            }
        }
        
        // Now compute the shadow regions
        var tags = {}
        var shining = {}
        Object.keys(resource.time_dag).forEach(version => tags[version] = {})
        function tag(version, t) {
            if (!tags[version][t]) {
                tags[version][t] = true
                Object.keys(resource.time_dag[version]).forEach(version => tag(version, t))
            }
        }

        Object.values(resource.fissures).forEach(f => {
            Object.keys(f.versions).forEach(v => {
                if (!resource.time_dag[v]) return
                tag(v, v)
                shining[v] = true
            })
        })

        var acked = resource.ancestors(resource.acked_boundary)
        Object.keys(resource.time_dag).forEach(x => {
            if (!acked[x] || resource.acked_boundary[x]) {
                tag(x, x)
                shining[x] = true
            }
        })

        var inv_tags = {}
        Object.entries(tags).forEach(([v, tags]) => {
            tags = Object.keys(tags).sort().join(':')
            if (!inv_tags[tags]) inv_tags[tags] = {}
            inv_tags[tags][v] = true
        })

        // compute "children" (the sort of inverse of resource.time_dag),
        // where values in time_dag represent "parents" of a node
        var children = {}
        Object.entries(resource.time_dag).forEach(([v, parents]) => {
            Object.keys(parents).forEach(parent => {
                if (!children[parent]) children[parent] = {}
                children[parent][v] = true
            })
        })

        // we'll aggregate bubble's to bloop here..
        var to_bubble = {}
        Object.entries(inv_tags).forEach(([_, members]) => {
            // members comprise a "shadow region",
            // but we now are going to find "bubble"s within it..

            // we start by assembling an appropriate dag to pass to find_bubbles..
            // it should look like {node_id_a: {parents: {}, children: {}}, ...}
            var dag = Object.fromEntries(Object.keys(members).map(member => [member, {
                parents: resource.time_dag[member],
                children: children[member]
            }]))

            // we'll get back a mapping from versions to their bubble's version (if they're in a bubble)
            Object.assign(to_bubble, find_bubbles(dag))
        })

        function find_bubbles(dag) {
            var to_bubble = {}
            var bubble_tops = {}
            var bubble_bottoms = {}
            
            function mark_bubble(bottom, top, tag) {
                if (!to_bubble[bottom]) {
                    to_bubble[bottom] = tag
                    if (bottom != top) Object.keys(dag[bottom].parents).forEach(p => mark_bubble(p, top, tag))
                }
            }
            
            var done = {}
            function f(cur) {
                var n = dag[cur]
                if (!n) return
                if (done[cur]) return
                done[cur] = true
                
                if (!to_bubble[cur] || bubble_tops[cur]) {
                    var bubble_top = find_one_bubble(dag, cur)
                    if (bubble_top) {
                        delete to_bubble[cur]
                        mark_bubble(cur, bubble_top, bubble_tops[cur] || cur)
                        bubble_tops[bubble_top] = bubble_tops[cur] || cur
                        bubble_bottoms[bubble_tops[cur] || cur] = bubble_top
                    }
                }
        
                Object.keys(n.parents).forEach(f)
            }
            Object.keys(find_leaves(dag)).forEach(f)
        
            return Object.fromEntries(Object.entries(to_bubble).map(([v, bub]) => [v, [bub, bubble_bottoms[bub]]]))
        }
        
        function find_one_bubble(dag, cur) {
            var seen = {[cur]: true}
            var q = Object.keys(dag[cur].parents)
            var expecting = Object.fromEntries(q.map(x => [x, true]))
            while (q.length) {
                cur = q.pop()
                if (!dag[cur]) return null
                if (Object.keys(dag[cur].children).every(c => seen[c])) {
                    seen[cur] = true
                    delete expecting[cur]
                    if (!Object.keys(expecting).length) return cur
                    
                    Object.keys(dag[cur].parents).forEach(p => {
                        q.push(p)
                        expecting[p] = true
                    })
                }
            }
            return null
        }
        
        function find_leaves(dag) {
            var leaves = Object.fromEntries(Object.keys(dag).map(k => [k, true]))
            Object.entries(dag).forEach(([k, node]) => {
                Object.keys(node.parents).forEach(p => delete leaves[p])
            })
            return leaves
        }

        /*
        resource.mergeable.prune(
            // Option 1: Pass in a set of versions    [xxxx eliminated xxxx]
            // Option 2: Pass a set of sets of versions
            // Option 3: Map each version to a shadow region (with an object or function)
            //    a) Pass in the object/function
            //    b) resource.time_shadows[version]   [xxxx eliminated xxxx]
        )
        */

        var seen_annotations = {}

        resource.mergeable.prune(to_bubble, seen_annotations)

        // Now we check to see if we can collapse the spacedag down to a literal.
        //
        // Todo: Move this code to the resource.mergeable.prune function.
        //       (this code also assumes there is a God (a single first version adder))
        var leaves = Object.keys(resource.current_version)
        var acked_boundary = Object.keys(resource.acked_boundary)
        var fiss = Object.keys(resource.fissures)
        if (leaves.length == 1 && acked_boundary.length == 1
            && leaves[0] == acked_boundary[0] && fiss.length == 0
            && !Object.keys(seen_annotations).length) {

            resource.time_dag = { [leaves[0]]: {} }
            var val = resource.mergeable.read_raw()
            resource.space_dag = (val && typeof(val) == 'object') ? {t: 'lit', S: val} : val
        }
    }

    node.create_joiner = (key) => {
        var resource = node.resource_at(key),
            // version = sjcl.codec.hex.fromBits(
            //     sjcl.hash.sha256.hash(
            //         Object.keys(resource.current_version).sort().join(':')))
            version = 'joiner:' + Object.keys(resource.current_version).sort().join(':')
        var joiner_num = Math.random()
        node.set({key, patches: [], version,
                  parents: Object.assign(u.dict(), resource.current_version),
                  joiner_num})
    }        

    node.default = (key, val) => {
        var is_wildcard = key[key.length-1] === '*'
        var v = val
        if (is_wildcard) {
            // Wildcard vals must be functions
            if (typeof val !== 'function')
                v = () => val
            node.default_patterns[key.substr(0,key.length-1)] = v
        }
        else
            node.defaults[key] = val
    }
    function default_val_for (key) {
        if (key in node.defaults) {
            // console.log('Default('+key+') is', node.defaults[key])
            return node.defaults[key]
        }

        for (pattern in node.default_patterns)
            if (pattern === key.substr(0, pattern.length)) {
                // console.log('Default('+key+') is', node.default_patterns[pattern])
                return node.default_patterns[pattern](key)
            }
    }
    node._default_val_for = default_val_for;

    function create_resource(resource = {}) {
        // The version history
        if (!resource.time_dag) resource.time_dag = {}
        if (!resource.current_version) resource.current_version = {}
        if (!resource.version_cache) resource.version_cache = {}
        resource.ancestors = (versions, ignore_nonexistent) => {
            var result = {}
            // console.log('ancestors:', versions)
            function recurse (version) {
                if (result[version]) return
                if (!resource.time_dag[version]) {
                    if (ignore_nonexistent) return
                    assert(false, 'The version '+version+' no existo')
                }
                result[version] = true
                Object.keys(resource.time_dag[version]).forEach(recurse)
            }
            Object.keys(versions).forEach(recurse)
            return result
        }
        resource.get_leaves = (versions) => {
            var leaves = {...versions}
            Object.keys(versions).forEach(v => {
                Object.keys(resource.time_dag[v]).forEach(p => delete leaves[p])
            })
            return leaves
        }

        // A data structure that can merge simultaneous operations
        resource.mergeable = require('./merge-algos/sync9.js')(resource)

        // Peers that we have sent a welcome message to
        if (!resource.keepalive_peers) resource.keepalive_peers = {}

        // Have we been welcomed yet?  (Has the data loaded?)
        if (!resource.weve_been_welcomed) resource.weve_been_welcomed = false

        // Disconnections that have occurred in the network without a forget()
        if (!resource.fissures) resource.fissures = {}

        // Acknowledgement data
        if (!resource.acked_boundary) resource.acked_boundary = {}
        if (!resource.unack_boundary) resource.unack_boundary = {}
        if (!resource.acks_in_process) resource.acks_in_process = {}

        // Empty versions sent to collapse outstanding parallel edits
        if (!resource.joiners) resource.joiners = {}
        
        return resource
    }
    node.create_resource = create_resource

    // ===============================================
    //
    //   Bindings:
    //
    //         Attaching pipes to events
    //
    function pattern_matcher () {
        // The pipes attached to each key, maps e.g. 'get /point/3' to '/30'
        var handlers = u.one_to_many()
        var wildcard_handlers = []  // An array of {prefix, funk}

        var matcher = {
            // A set of timers, for keys to send forgets on
            bind (key, pipe, allow_wildcards) {
                allow_wildcards = true // temporarily
                if (allow_wildcards && key[key.length-1] === '*')
                    wildcard_handlers.push({prefix: key, pipe: pipe})
                else
                    handlers.add(key, pipe.id, pipe)

                // Now check if the method is a get and there's a gotton
                // key in this space, and if so call the handler.
            },

            unbind (key, pipe, allow_wildcards) {
                allow_wildcards = true // temporarily
                if (allow_wildcards && key[key.length-1] === '*')
                    // Delete wildcard connection
                    for (var i=0; i<wildcard_handlers.length; i++) {
                        var handler = wildcard_handlers[i]
                        if (handler.prefix === key && handler.pipe.id === pipe.id) {
                            wildcard_handlers.splice(i,1)  // Splice this element out of the array
                            i--                            // And decrement the counter while we're looping
                        }
                    }
                else
                    // Delete direct connection
                    handlers.delete(key, pipe.id)
            },

            bindings (key) {
                // Note:
                //
                // We need the bindings that persist state to the database to come
                // first.  In statebus we added a .priority flag to them, and
                // processed those priority handlers first.  We haven't implemented
                // that yet, and are just relying on setting these handlers first in
                // the array and hash, which makes them come first.  But we need to
                // make this more robust in the future.
                //
                // We might, instead of doing a .priority flag, have separate
                // .on_change and .on_change_sync handlers.  Then the database stuff
                // would go there.

                assert(typeof key === 'string',
                       'Error: "' + key + '" is not a string')

                var result = u.dict()

                // First get the exact key matches
                var pipes = handlers.get(key)
                for (var i=0; i < pipes.length; i++)
                    result[pipes[i].id] = pipes[i]

                // Now iterate through prefixes
                for (var i=0; i < wildcard_handlers.length; i++) {
                    var handler = wildcard_handlers[i]
                    var prefix = handler.prefix.slice(0, -1)       // Cut off the *

                    if (prefix === key.substr(0,prefix.length))
                        // If the prefix matches, add it to the list!
                        result[handler.pipe.id] = handler.pipe
                }
                return Object.values(result)
            }
        }
        return matcher
    }

    // Give the node all methods of a pattern matcher, to bind keys and pipes
    Object.assign(node, pattern_matcher())

    node.websocket_client = (args) => require('./protocol-websocket/websocket-client.js')({
        ...args,
        node: node,
        create_websocket: () => new (require('ws'))(args.url)
    })

    return node
}
