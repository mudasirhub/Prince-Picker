/**
 * Prince Picker PWA Bridge
 * Connects to the local POS Socket.IO server on port 3002.
 * Integrates with the Picker app's STATE to update online/offline status.
 */

(function () {
    // Dynamically connect to the PC's bridge server instead of assuming localhost
    const host = window.location.hostname || 'localhost';
    const BRIDGE_URL = window.location.protocol + '//' + host + ':3002';
    let socket = null;
    let pickerId = localStorage.getItem('picker_id') || ('P-' + Math.floor(Math.random()*10000));
    localStorage.setItem('picker_id', pickerId);
    let activeTask = null;
    let pingInterval;
    let scriptLoadFailed = false;
    // Expose bridge status to the main app
    window.PICKER_BRIDGE = {
        connected: false,
        socket: null,
        bridgeUrl: BRIDGE_URL,
        getStatus: function() { return socket && socket.connected ? 'connected' : 'disconnected'; },
        emitComplete: function(taskId) {
            if (socket && socket.connected && taskId) {
                socket.emit('task_complete', { task_id: taskId });
            }
        }
    };

    /**
     * Load socket.io — try bridge server first (it serves /socket.io/socket.io.js),
     * then fall back to CDN for cold-start (before bridge is ready).
     */
    function loadSocketIO(callback) {
        if (typeof io !== 'undefined') { callback(); return; }

        var bridgeSrc = BRIDGE_URL + '/socket.io/socket.io.js';
        var cdnSrc = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
        var isLocalEnv = host === 'localhost' || host === '127.0.0.1' || /^192\.168\./.test(host);

        var primarySrc = isLocalEnv ? bridgeSrc : cdnSrc;
        var fallbackSrc = isLocalEnv ? cdnSrc : bridgeSrc;

        function tryLoad(src, fallback) {
            var s = document.createElement('script');
            s.src = src;
            var timer = setTimeout(function() {
                if (s.onerror) s.onerror();
            }, 6000);

            s.onload = function() {
                clearTimeout(timer);
                scriptLoadFailed = false;
                callback();
            };
            s.onerror = function() {
                clearTimeout(timer);
                s.onload = null;
                s.onerror = null;
                if (s.parentNode) s.parentNode.removeChild(s);

                if (fallback) {
                    tryLoad(fallback, null);
                } else {
                    scriptLoadFailed = true;
                    updatePickerAppStatus(false);
                    setTimeout(function() { loadSocketIO(initBridge); }, 30000);
                }
            };
            document.head.appendChild(s);
        }

        tryLoad(primarySrc, fallbackSrc);
    }

    loadSocketIO(initBridge);

    function initBridge() {
        if (typeof io === 'undefined') return;
        
        var customServer = localStorage.getItem('bridge_server');
        // Do not auto-connect to port 3002 on public web deployments unless a custom bridge server is specified
        if (!isLocalEnv && !customServer) {
            console.log('[PickerBridge] Public web deployment detected — skipping default port 3002 auto-connect.');
            return;
        }

        var targetUrl = customServer || BRIDGE_URL;
        socket = io(targetUrl + '/io/picker', { 
            reconnectionDelay: 5000,
            reconnectionAttempts: 5,
            reconnection: true,
            timeout: 5000
        });
        window.PICKER_BRIDGE.socket = socket;

        socket.on('connect', function() {
            console.log('[PickerBridge] Connected to bridge server');
            window.PICKER_BRIDGE.connected = true;

            var nameToRegister = (typeof STATE !== 'undefined' && STATE.pickerName) 
                ? STATE.pickerName 
                : ('Picker ' + pickerId.slice(-3));

            socket.emit('register_picker', { picker_id: pickerId, picker_name: nameToRegister });
            socket.emit('restore_session', { picker_id: pickerId });
            
            // Update the main Picker app's online status
            updatePickerAppStatus(true);

            clearInterval(pingInterval);
            pingInterval = setInterval(function() {
                socket.emit('heartbeat', { picker_id: pickerId });
            }, 12000);
        });

        socket.on('disconnect', function() {
            console.log('[PickerBridge] Disconnected from bridge server');
            window.PICKER_BRIDGE.connected = false;
            clearInterval(pingInterval);
            // Update the main Picker app's online status
            updatePickerAppStatus(false);
        });

        socket.on('reconnect', function() {
            console.log('[PickerBridge] Reconnected to bridge server');
            window.PICKER_BRIDGE.connected = true;
            updatePickerAppStatus(true);
        });

        socket.on('registered_ok', function(data) {
            console.log('[PickerBridge] Registration confirmed:', data);
        });

        socket.on('new_pick_task', function(task) {
            console.log('[PickerBridge] New task:', task);
            activeTask = task;
            showTaskOverlay(task);
            playAlert();
        });

        socket.on('task_cancelled', function(data) {
            if (activeTask && activeTask.task_id === data.task_id) {
                activeTask = null;
                var overlay = document.getElementById('bridge-overlay');
                if (overlay) overlay.remove();
                if (typeof toast === 'function') {
                    toast('Task cancelled: ' + (data.reason || 'unknown'), 'err');
                } else {
                    alert('Task cancelled by POS: ' + data.reason);
                }
            }
        });
    }

    /**
     * Update the Picker app's STATE.online and the orderOnline/orderOffline badges.
     * This bridges the gap between the Socket.IO connection and the app's UI.
     */
    function updatePickerAppStatus(isConnected) {
        // Update STATE if available
        if (typeof STATE !== 'undefined') {
            STATE.online = isConnected;
            // If we just connected and have a server URL, also set that
            if (isConnected && !STATE.serverUrl) {
                STATE.serverUrl = BRIDGE_URL;
            }
        }

        // Update UI badges
        var onlineBadge = document.getElementById('orderOnline');
        var offlineBadge = document.getElementById('orderOffline');
        
        if (onlineBadge) {
            onlineBadge.style.display = isConnected ? 'inline-flex' : 'none';
        }
        if (offlineBadge) {
            offlineBadge.style.display = isConnected ? 'none' : 'inline-flex';
        }

        // Also update the login screen badge if visible
        var serverBadge = document.getElementById('serverBadge');
        if (serverBadge) {
            if (isConnected) {
                serverBadge.className = 'server-badge ok';
                serverBadge.textContent = 'Bridge Connected';
            }
            // Don't overwrite login badge if not connected — login has its own logic
        }
    }

    function playAlert() {
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc = ctx.createOscillator();
            osc.connect(ctx.destination);
            osc.frequency.value = 800;
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
        } catch(e){}
    }

    function showTaskOverlay(task) {
        var overlay = document.getElementById('bridge-overlay');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'bridge-overlay';
        overlay.style.cssText = '\
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;\
            background: rgba(0,0,0,0.85); z-index: 999999;\
            display: flex; flex-direction: column; justify-content: center; align-items: center;\
            backdrop-filter: blur(5px);\
        ';

        var borderColor = task.priority === 'urgent' ? '#ef4444' : '#3b82f6';
        var box = document.createElement('div');
        box.style.cssText = '\
            background: #1e293b; border-radius: 20px; padding: 24px; width: 90%; max-width: 400px;\
            box-shadow: 0 10px 40px rgba(0,0,0,0.5); text-align: center; color: white;\
            border: 2px solid ' + borderColor + ';\
        ';

        box.innerHTML = '\
            <div style="font-size:12px;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:8px">New Task Assigned</div>\
            <h2 style="margin:0 0 16px 0;font-size:24px;color:#f8fafc">Bill: ' + task.bill_no + '</h2>\
            <div style="background:#0f172a;padding:12px;border-radius:10px;margin-bottom:24px">\
                <div style="font-size:28px;font-weight:800;color:#22c55e">' + task.items.length + '</div>\
                <div style="font-size:12px;color:#64748b;text-transform:uppercase">Items to Pick</div>\
            </div>\
            <div style="display:flex;gap:12px">\
                <button id="bridge-btn-reject" style="flex:1;padding:14px;border-radius:12px;border:none;background:#334155;color:white;font-weight:700;font-size:16px;cursor:pointer">Reject</button>\
                <button id="bridge-btn-accept" style="flex:2;padding:14px;border-radius:12px;border:none;background:#22c55e;color:white;font-weight:700;font-size:16px;cursor:pointer">Accept Task</button>\
            </div>\
            <div id="bridge-timer" style="margin-top:16px;font-size:12px;color:#ef4444;font-weight:700">Auto-reject in 45s</div>\
        ';
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var timeLeft = 45;
        var tInt = setInterval(function() {
            timeLeft--;
            var tmr = document.getElementById('bridge-timer');
            if (tmr) tmr.textContent = 'Auto-reject in ' + timeLeft + 's';
            if (timeLeft <= 0) {
                clearInterval(tInt);
                if (socket && socket.connected) {
                    socket.emit('reject_task', { task_id: task.task_id, reason: 'Timeout (No response)' });
                }
                overlay.remove();
            }
        }, 1000);

        document.getElementById('bridge-btn-accept').onclick = function() {
            clearInterval(tInt);
            socket.emit('accept_task', { task_id: task.task_id });
            overlay.remove();
            startPicking(task);
        };
        document.getElementById('bridge-btn-reject').onclick = function() {
            clearInterval(tInt);
            socket.emit('reject_task', { task_id: task.task_id, reason: 'Declined by picker' });
            overlay.remove();
        };
    }

    function startPicking(task) {
        // Create a native order matching the task
        var newOrder = {
            order_id: task.bill_no,
            status: 'assigned',
            picker: (typeof STATE !== 'undefined' && STATE.pickerName) ? STATE.pickerName : 'Picker',
            items: task.items.map(function(item) {
                return {
                    barcode: item.barcode || item.id || '',
                    qty: item.qty,
                    status: 'pending',
                    picked: 0
                };
            }),
            task_id: task.task_id
        };

        // Remove any existing order with the same order_id to prevent duplicates
        if (typeof STATE !== 'undefined' && STATE.orders) {
            STATE.orders = STATE.orders.filter(function(o) {
                return o.order_id !== task.bill_no;
            });
            STATE.orders.unshift(newOrder);
            if (typeof renderOrders === 'function') {
                renderOrders();
            }
        }

        // Use toast if available, else alert
        if (typeof toast === 'function') {
            toast('Task Accepted! Starting pick session for ' + task.bill_no, 'ok');
        } else {
            alert('Task Accepted! Starting pick session for ' + task.bill_no);
        }

        // Immediately launch the native picking session
        if (typeof startPickingSession === 'function') {
            startPickingSession(newOrder);
        } else {
            if (typeof toast === 'function') {
                toast('Go to Orders screen to start picking ' + task.bill_no, 'info');
            }
        }
    }

    // Re-register with picker name when the user logs in
    // The main app can call this after login
    window.PICKER_BRIDGE.updatePickerName = function(name) {
        if (socket && socket.connected && name) {
            socket.emit('register_picker', { 
                picker_id: pickerId, 
                picker_name: name 
            });
        }
    };
})();
