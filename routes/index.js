var http = require('request');
var cors = require('cors');
var uuid = require('uuid');
var url = require('url');

var redis = require('redis');
var client;
var env = process.env.NODE_ENV || 'dev';
if (env == 'dev') {
    client = redis.createClient();
} else {
    client = redis.createClient(process.env.REDIS_URL);
}

client.on('connect', function () {
    console.log("connected to redis");
});

var fs = require('fs');
var request = require('request');
var cheerio = require('cheerio');
var CircularBuffer = require("circular-buffer");
var parseDuration = require('parse-duration');
var async = require("async");

var lastStatus;
var statuses = {};
var interval;
var REFRESH_RATE = 10 * 1000; // 10 seconds
var VERSION = "8.1.1";
var USE_CROWD = false;
var MY_ID = process.env.MY_ID;
var VALID_REGIONS = ["united states", "united kingdom", "germany", "italy", "new zealand", "argentina", "australia", "austria",
    "belgium", "brazil", "bulgaria", "canada", "chile", "croatia", "czech republic", "denmark", "estonia", "finland", "greece",
    "hong kong", "hungary", "iceland", "india", "indonesia", "ireland", "japan", "latvia", "lithuania", "netherlands",
    "norway", "other", "poland", "portugal", "romania", "singapore", "slovakia", "slovenia", "spain", "sweden", "switzerland", "taiwan", "thailand"
];

function generateQueue() {
    return new CircularBuffer(3);
}

// This is the heart of your HipChat Connect add-on. For more information,
// take a look at https://developer.atlassian.com/hipchat/tutorials/getting-started-with-atlassian-connect-express-node-js
module.exports = function (app, addon) {
    var hipchat = require('../lib/hipchat')(addon);

    // simple healthcheck
    app.get('/healthcheck', function (req, res) {
        res.send('OK');
    });

    // Root route. This route will serve the `addon.json` unless a homepage URL is
    // specified in `addon.json`.
    app.get('/',
        function (req, res) {
            // Use content-type negotiation to choose the best way to respond
            res.format({
                // If the request content-type is text-html, it will decide which to serve up
                'text/html': function () {
                    var homepage = url.parse(addon.descriptor.links.homepage);
                    if (homepage.hostname === req.hostname && homepage.path === req.path) {
                        res.render('homepage', addon.descriptor);
                    } else {
                        res.redirect(addon.descriptor.links.homepage);
                    }
                },
                // This logic is here to make sure that the `addon.json` is always
                // served up when requested by the host
                'application/json': function () {
                    res.redirect('/atlassian-connect.json');
                }
            });
        }
    );

    // This is an example route that's used by the default for the configuration page
    // https://developer.atlassian.com/hipchat/guide/configuration-page
    app.get('/config',
        // Authenticates the request using the JWT token in the request
        addon.authenticate(),
        function (req, res) {
            // The `addon.authenticate()` middleware populates the following:
            // * req.clientInfo: useful information about the add-on client such as the
            //   clientKey, oauth info, and HipChat account info
            // * req.context: contains the context data accompanying the request like
            //   the roomId
            res.render('config', req.context);
        }
    );

    // This is an example glance that shows in the sidebar
    // https://developer.atlassian.com/hipchat/guide/glances
    app.get('/glance',
        cors(),
        addon.authenticate(),
        function (req, res) {
            url = 'http://cmmcd.com/PokemonGo/';
            request(url, function (error, response, text) {
                if (!error) {
                    var $ = cheerio.load(text);
                    var status;
                    $('.jumbotron table tr td h2').filter(function () {
                        var data = $(this);
                        text = data.text();
                        status = data.children().first().text();

                        var type;
                        if (status.includes("Online")) {
                            type = "success";
                        } else if (status.includes("Unstable") || status.includes("Laggy")) {
                            type = "current";
                        } else {
                            type = "error";
                        }
                        res.json({
                            "label": {
                                "type": "html",
                                "value": "PoGo Server Is "
                            },
                            "status": {
                                "type": "lozenge",
                                "value": {
                                    "label": status,
                                    "type": type
                                }
                            }
                        });
                    });
                }
            });
        }
    );

    function updateGlance(req, status, text) {
        console.log("update glance to " + status);
        var type;
        if (status.includes("Online")) {
            type = "success";
        } else if (status.includes("Unstable") || status.includes("Laggy")) {
            type = "current";
        } else {
            type = "error";
        }
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        hipchat.sendGlance(clientId, roomId, "serverStatus.glance", {
            "label": {
                "type": "html",
                "value": "PoGo Server Is "
            },
            "status": {
                "type": "lozenge",
                "value": {
                    "label": status,
                    "type": type
                }
            }
        });
    }

    function updateGlances(status, text, region = false) {
        console.log(region + ": update all glances to " + status);
        var type;
        if (status.includes("Online")) {
            type = "success";
        } else if (status.includes("Unstable") || status.includes("Laggy")) {
            type = "current";
        } else {
            type = "error";
        }
        getActiveRooms(region, function (rooms) {
            rooms.forEach(function (room) {
                hipchat.sendGlance(room.clientInfo, room.id, "serverStatus.glance", {
                    "label": {
                        "type": "html",
                        "value": "PoGo Server Is "
                    },
                    "status": {
                        "type": "lozenge",
                        "value": {
                            "label": status,
                            "type": type
                        }
                    }
                });
            });
        });
    }

    // This is an example route to handle an incoming webhook
    // https://developer.atlassian.com/hipchat/guide/webhooks
    app.post('/webhook',
        addon.authenticate(),
        function (req, res) {
            // console.log(req.body);
            var clientId = req.body.oauth_client_id;
            var room = req.body.item.room;
            //addon.settings.set(room.id, {version: VERSION, pings: [], muted: []}, clientId);
            console.log(req.body.item.message.message);
            //client.del("rooms", function(err, reply) {});

            // client.del("listening", function(err, reply) {});
            hipchat.sendMessage(req.clientInfo, req.identity.roomId, 'pong pong')
                .then(function (data) {
                    res.sendStatus(200);
                });
        }
    );

    app.post('/help',
        addon.authenticate(),
        function (req, res) {
            helpString = "<b>/server</b>: Checks the server status.<br>" +
                "<b>/help</b>, <b>/h</b>: shows you what the commands do<br/>" +
                "<b>/subs</b>: Displays the ping names of people who will receive notification if the server status changes<br/>" +
                "<b>/add</b>: adds yourself to the subscriber list<br/>" +
                "<b>/remove</b>: removes yourself from the subscriber list<br/>" +
                "<b>/start</b>: starts listening for server status changes<br/>" +
                "<b>/stop</b>: stops listening for server status changes<br/>" +
                "<b>/version</b>, <b>/v</b>: lists the version of the bot in the form 'major.minor.patch'. If the major numbers are different, you need to uninstall and reinstall the bot to get the latest features<br/>" +
                "<b>/mute</b>: unsubscribes you for the time specified (/mute 20 s, /mute 30 minutes )<br/>" +
                "<b>/mutes</b>: displays the people who have muted and how much longer they have left<br/>" +
                "<b>/region</b>: displays your current region that your room is set to<br/>" +
                "<b>/regions</b>: displays the supported regions<br/>" +
                "<b>/select</b>: changes your region server to check<br/>" +
                "If you are not getting updates and you are supposed to, try '/stop' and then '/start'. The bot may of not stored your room right.<br/>" +
                "Source code: <a href='https://github.com/baseballlover723/hipchat-pokemon-go-server-status-bot'>https://github.com/baseballlover723/hipchat-pokemon-go-server-status-bot</a> <br/>" +
                "Want to contact me, <a href='mailto:pokemongohipchatbot@gmail.com?Subject=Pokemon%20Go%20Hipchat%20Bot'>send me an email</a> at 'pokemongohipchatbot@gmail.com'";
            sendMessage(req, helpString, {}, function () {
                res.sendStatus(200);
            });
        }
    );

    app.post('/server',
        addon.authenticate(),
        function (req, res) {
            var room = req.body.item.room;
            getRoomRegion(room, function (region) {
                checkServer(region, req, function (status, text) {
                    setLastStatus(region, status);
                    addStatus(region, status);
                    sendMessage(req, text, {}, function () {
                        res.sendStatus(200);
                    });
                });
            });
        }
    );

    app.post('/add',
        addon.authenticate(),
        function (req, res) {
            var user = req.body.item.message.from;

            addUser(req, user, function (added) {
                if (added) {
                    sendMessage(req, "added " + user.name + " to subscriber list", {}, function () {
                        res.sendStatus(200);
                    });
                } else {
                    sendMessage(req, user.name + " is already subscribed", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/remove',
        addon.authenticate(),
        function (req, res) {
            var user = req.body.item.message.from;

            removeUser(req, user, function (removed) {
                if (removed) {
                    sendMessage(req, user.name + " has unsubscribed :(", {}, function () {
                        res.sendStatus(200);
                    });
                } else {
                    sendMessage(req, user.name + " wasn't subscribed", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/subs',
        addon.authenticate(),
        function (req, res) {
            getMentions(req, function (names) {
                if (names.length > 0) {
                    var message = "current subs are (ping names): ";
                    names.forEach(function (name) {
                        message += " " + name;
                    });
                    sendMessage(req, message, {}, function () {
                        res.sendStatus(200);
                    });
                } else {
                    sendMessage(req, "There are no subscribers :(", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/start',
        addon.authenticate(),
        function (req, res) {
            if (!interval) {
                startInterval();
            }
            startRoomListening(req, function (added) {
                if (added) {
                    sendMessage(req, "I'll let you know if the server status changes");
                    var room = req.body.item.room;
                    getRoomRegion(room, function (region) {
                        checkServer(region, req, function (status, text) {
                            addStatus(region, status);
                            sendMessage(req, text, {}, function () {
                                res.sendStatus(200);
                            });
                        });
                    });
                } else {
                    sendMessage(req, "I'm already listening for server changes", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/stop',
        addon.authenticate(),
        function (req, res) {
            var room = req.body.item.room;
            stopRoomListening(room, function (removed) {
                if (removed) {
                    sendMessage(req, "I'm not listening for server changes anymore", {}, function () {
                        res.sendStatus(200);
                        noActiveRooms(req, function (noActiveRooms) {
                            if (noActiveRooms) {
                                clearInterval(interval);
                                interval = false;
                            }
                        });
                    });
                } else {
                    sendMessage(req, "I'm not listening for server changes", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/active',
        addon.authenticate(),
        function (req, res) {
            if (MY_ID == req.body.item.message.from.id) {
                getActiveRooms(false, function (rooms) {
                    if (rooms.length > 0) {
                        var roomNames = [];
                        rooms.map(function (room) { roomNames.push(room.name + ": " + room.id)});
                        sendMessage(req, roomNames.join(" * ") + "<br/>number of active rooms: " + rooms.length, {}, function () {
                            res.sendStatus(200);
                        });
                    } else {
                        sendMessage(req, "No active rooms", {}, function () {
                            res.sendStatus(200);
                        });
                    }
                });
            } else {
                console.log("you cant use active, id must be: " + MY_ID + ", yours is " + req.body.item.message.from.id);
                res.sendStatus(200);
            }
        }
    );

    app.post('/version',
        addon.authenticate(),
        function (req, res) {
            checkVersion(req, function (installedVersion, needUpgrade) {
                if (needUpgrade) {
                    sendMessage(req, installedVersion + " you need to upgrade, latest version is " + VERSION, {}, function () {
                        res.sendStatus(200);
                    });
                } else {
                    sendMessage(req, VERSION + " (up to date)", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/mute',
        addon.authenticate(),
        function (req, res) {
            addMute(req, function (user, time) {
                if (time) {
                    sendMessage(req, "muted " + user.name + " for " + timeConversion(time), {}, function () {
                        res.sendStatus(200);
                    });
                } else {
                    sendMessage(req, user.name + " is not getting notifications", {}, function () {
                        res.sendStatus(200);
                    });
                }
            });
        }
    );

    app.post('/mutes',
        addon.authenticate(),
        function (req, res) {
            getMutesString(req, function (mutesString) {
                sendMessage(req, mutesString, {}, function () {
                    res.sendStatus(200);
                });
            });
        }
    );

    app.post('/rooms',
        addon.authenticate(),
        function (req, res) {
            if (MY_ID == req.body.item.message.from.id) {
                getInstalledRooms(function (rooms) {
                    var roomNames = rooms.map(function (room) {return room.name + ": " + room.id});
                    sendMessage(req, roomNames.join(" * ") + "<br/>number of rooms: " + roomNames.length, {}, function () {
                        res.sendStatus(200);
                    });
                });
            } else {
                res.sendStatus(200);
            }
        }
    );

    app.post('/select',
        addon.authenticate(),
        function (req, res) {
            console.log("update region server");
            var room = req.body.item.room;
            var region = req.body.item.message.message.replace("/select", "").trim().toLowerCase();
            console.log(region);
            if (validRegion(region)) {
                changeRegion(room, region, function (newRegion) {
                    if (newRegion) {
                        sendMessage(req, "your selected region is now '" + newRegion + "'", {}, function () {
                            res.sendStatus(200);
                        });
                    } else {
                        sendMessage(req, "your selected region is already '" + region + "'", {}, function () {
                            res.sendStatus(200);
                        });
                    }
                });
            } else {
                var validRegionsString = getValidRegions().map(function (region) {return "'" + region + "'"}).join(", ");
                sendMessage(req, "'" + region + "' is not a valid region, valid regions are: " + validRegionsString);
                res.sendStatus(200);
            }
        }
    );

    app.post('/region',
        addon.authenticate(),
        function (req, res) {
            var room = req.body.item.room;
            getRoomRegion(room, function (region) {
                sendMessage(req, "your selected region is '" + region.capitalize() + "'", {}, function () {
                    res.sendStatus(200);
                });
            });
        }
    );

    app.post('/regions',
        addon.authenticate(),
        function (req, res) {
            var room = req.body.item.room;
            var regions = getValidRegions();
            var regionsStr = regions.map(function (r) {return "'" + r + "'";}).join(", ");
            sendMessage(req, "valid regions are " + regionsStr, {}, function () {
                res.sendStatus(200);
            });
        }
    );

    function startRoomListening(req, callback = function (added) {}) {
        var room = req.body.item.room;
        var clientId = req.body.oauth_client_id;
        isRoomListening(req, function (listening) {
            if (!listening) {
                var done = false;
                getRoomRegion(room, function (region) {
                    client.sadd(["listening", room.id], function (err, reply) {
                        client.hmset([room.id, "id", room.id, "clientInfoJson", JSON.stringify(req.clientInfo), "name", room.name, "region", region], function (err, reply) {
                            console.log("room: " + room.name + " has started listening");
                            if (done) {
                                callback(true);
                            } else {
                                done = true;
                            }
                        });
                    });

                    client.sadd([region, room.id], function (err, reply) {
                        client.sadd(["regions", region], function (err, reply) {
                            if (done) {
                                callback(true);
                            } else {
                                done = true;
                            }
                        });
                    });
                });
            } else {
                callback(false);
            }
        });
    }

    function isRoomListening(req, callback = function (listening) {}) {
        var room = req.body.item.room;
        client.sismember(["listening", room.id], function (err, reply) {
            callback(reply == 1);
        });
    }

    function noActiveRooms(req, callback = function (noActiveRooms) {}) {
        client.scard("listening", function (err, reply) {
            callback(reply == 0);
        });
    }

    function checkVersion(req, callback = function (installedVersion, needUpgrade) {}) {
        getData(req, function (data) {
            callback(data.version, needUpgrade(data.version));
        });
    }

    function needUpgrade(installedVersion) {
        var installedMajor = parseInt(installedVersion.split(".")[0]);
        var major = parseInt(VERSION.split(".")[0]);
        return installedMajor < major;
    }

    function startInterval() {
        clearStatuses();
        console.log("starting interval");
        lastStatus = {};
        interval = setInterval(function () {
            console.log("********************************");
            getListeningRegions(function (regions) {
                console.log("listening regions: [" + regions.map(function (r) {return "'" + r + "'"}).join(", ") + "]");
                regions.forEach(function (region) {
                    checkServer(region, false, function (status, text) {
                        console.log(region + ": recent statuses: [" + getStatuses(region).toarray().map(function (r) {return "'" + r + "'"}).join(", ") + "]");
                        if (status.includes("Offline") || status.includes("Unstable") || status.includes("Laggy")) {
                            if ((status.includes("Unstable") && !seenStatusRecently(region, "Unstable")) || (status.includes("Laggy") && !seenStatusRecently(region, "Laggy"))) {
                                console.log(region + ": sent message case 1 " + JSON.stringify(lastStatus));
                                setLastStatus(region, status);
                                sendMessageToAll(text, region, {options: {notify: true, format: "text", pings: true}});
                            } else if (status.includes("Offline")) {
                                if (allStatusRecently(region, "Offline") && !getLastStatus(region).includes("Offline")) {
                                    console.log(region + ": sent message case 2 " + JSON.stringify(lastStatus));
                                    setLastStatus(region, status);
                                    sendMessageToAll(text, region, {
                                        options: {
                                            notify: true,
                                            format: "text",
                                            pings: true
                                        }
                                    });
                                }
                                if (!seenStatusRecently(region, "Offline") && !getLastStatus(region).includes("Unstable") && !getLastStatus(region).includes("Laggy")) {
                                    console.log(region + ": sent message case 3 " + JSON.stringify(lastStatus));
                                    setLastStatus(region, status);
                                    sendMessageToAll(text, region, {
                                        options: {
                                            notify: true,
                                            format: "text",
                                            pings: true
                                        }
                                    });
                                    // lastStatus = "Unstable";
                                    // sendMessageToAll(text.replace("Offline", "Unstable"), region, {
                                    //     options: {
                                    //         notify: true,
                                    //         format: "text",
                                    //         pings: true
                                    //     }
                                    // });
                                }
                            }
                        } else if (status.includes("Online")) {
                            if (!allStatusRecently(region, "Online") && getStatuses(region).size() > 0) {
                                console.log(region + ": sent message case 4 (Online) " + JSON.stringify(lastStatus));
                                clearStatuses(region);
                                setLastStatus(region, status);
                                sendMessageToAll(text, region, {options: {notify: true, format: "text", pings: true}});
                            }
                        }
                        addStatus(region, status);
                    });
                });
            });
        }, REFRESH_RATE);
        // storeInterval(req, interval);
    }

    function getLastStatus(region) {
        return lastStatus[region] || "";
    }

    function setLastStatus(region, status) {
        lastStatus[region] = status;
    }

    function addStatus(region, status) {
        getStatuses(region).enq(status);
    }

    function getStatuses(region) {
        if (!statuses[region]) {
            statuses[region] = generateQueue();
        }
        return statuses[region];
    }

    function clearStatuses(region = false) {
        if (region) {
            var statusQueue = getStatuses(region);
            while (statusQueue.size() > 0) {
                statusQueue.deq();
            }
        } else {
            statuses = {};
        }
    }

    function allStatusRecently(region, statusString) {
        var statusQueue = getStatuses(region);
        if (statusQueue.size() == 0) {
            return false
        }
        var arr = statusQueue.toarray();
        for (var i in arr) {
            var status = arr[i];
            if (!status.includes(statusString)) {
                return false;
            }
        }
        return true;
    }

    function seenStatusRecently(region, statusString) {
        var statusQueue = getStatuses(region);
        var arr = statusQueue.toarray();
        for (var i in arr) {
            var status = arr[i];
            if (status.includes(statusString)) {
                return true;
            }
        }
        return false;
    }

    function getMentionsString(req, callback) {
        checkMuted(req, function () {
            getData(req, function (data) {
                var mentionNames = "";
                data.pings.forEach(function (user) {
                    mentionNames += " @" + user.mention_name;
                });

                callback(mentionNames);
            });
        });
    }

    function getMentions(req, callback) {
        checkMuted(req, function () {
            getData(req, function (data) {
                var mentionNames = [];
                data.pings.forEach(function (user) {
                    mentionNames.push(user.mention_name);
                });

                callback(mentionNames);
            });
        });
    }

    function getMutesString(req, callback = function (mutesString) {}) {
        checkMuted(req, function () {
            getData(req, function (data) {
                var now = new Date();
                var mutesString = "";
                if (data.muted.length > 0) {
                    for (var mute of data.muted) {
                        mutesString += mute.user.name;
                        mutesString += ": ";
                        mutesString += timeConversion(new Date(mute.endTime) - now);
                        mutesString += "<br/>\n";
                    }
                } else {
                    mutesString = "No one is currently being muted";
                }
                callback(mutesString);
            });
        });
    }

    function addMute(req, callback = function (user, time) {}) {
        var user = req.body.item.message.from;
        var time = parseDuration(req.body.item.message.message);
        var endTime = new Date(new Date().getTime() + time);
        var found = false;
        getData(req, function (data) {
            for (var index in data.muted) {
                var muted = data.muted[index];
                if (muted.user.id == user.id) {
                    muted.endTime = endTime.getTime();
                    found = true;
                    setData(req, data);
                    callback(user, time);
                    return;
                }
            }
            var userIndex;
            if (!found) {
                if ((userIndex = includesUser(data.pings, user))) {
                    data.pings.splice(userIndex, 1);
                    data.muted.push({user: user, endTime: endTime.getTime()});
                    setData(req, data);
                    callback(user, time);
                } else {
                    callback(user, false);
                }
            }
        });

    }

    function checkMuted(req, callback = function () {}) {
        var currentTime = new Date();
        getData(req, function (data) {
            for (var index in data.muted) {
                var muted = data.muted[index];
                var user = muted.user;
                if (muted.endTime < currentTime) {
                    data.muted.splice(index, 1);
                    if (!includesUser(data.pings, user)) {
                        data.pings.push(user);
                    }
                }
            }
            setData(req, data);
            callback();
        });
    }

    function addUser(req, user, callback = function (added) {}) {
        getData(req, function (data) {
            if (!includesUser(data.pings, user)) {
                data.pings.push(user);
                setData(req, data);
                callback(true);
            } else {
                callback(false)
            }
        });
    }

    function removeUser(req, user, callback = function () {}) {
        getData(req, function (data) {
            var index;
            if (index = includesUser(data.pings, user)) {
                data.pings.splice(index, 1);
                setData(req, data);
                callback(user);
            } else {
                callback(false)
            }
        });
    }

    function includesUser(arr, user) {
        for (var index in arr) {
            var storedUser = arr[index];
            if (storedUser.id == user.id) {
                return index;
            }
        }
        return false;
    }

    function sendMessage(req, message, ops = {}, callback = function () {}) {
        checkVersion(req, function (installedVersion, needUpgrade) {
            if (needUpgrade) {
                hipchat.sendMessage(req.clientInfo, req.identity.roomId, "You need to upgrade this plugin by uninstalling and reinstalling the plugin here: https://marketplace.atlassian.com/plugins/pokemon-go-server-status-bot/cloud/overview", {options: {format: "text"}});
            }
            hipchat.sendMessage(req.clientInfo, req.identity.roomId, message, ops).then(function () {
                callback();
            });
        });
    }

    function sendMessageToAll(message, region = false, ops = {options: {}}) {
        console.log(region + ": sending message to all listening rooms in region");

        getActiveRooms(region, function (rooms) {
            rooms.forEach(function (room) {
                    if (ops.options.pings) {
                        getMentionsString({
                            body: {
                                oauth_client_id: room.clientInfo.clientKey,
                                item: {room: room}
                            }
                        }, function (pings) {
                            // hipchat.sendMessage(room.clientInfo, room.id, message + pings, ops);
                            checkVersion({
                                body: {oauth_client_id: room.clientInfo.clientKey, item: {room: room}},
                                function(installedVersion, needUpgrade) {
                                    if (needUpgrade) {
                                        // hipchat.sendMessage(room.clientInfo, room.id, "You need to upgrade this plugin by uninstalling and reinstalling the plugin here: https://marketplace.atlassian.com/plugins/pokemon-go-server-status-bot/cloud/overview", {options: {format: "text"}});
                                    }
                                }
                            });
                        });
                    } else {
                        // hipchat.sendMessage(room.clientInfo, room.id, message, ops);
                        checkVersion({
                            body: {oauth_client_id: room.clientInfo.clientKey, item: {room: room}},
                            function(installedVersion, needUpgrade) {
                                if (needUpgrade) {
                                    // hipchat.sendMessage(room.clientInfo, room.id, "You need to upgrade this plugin by uninstalling and reinstalling the plugin here: https://marketplace.atlassian.com/plugins/pokemon-go-server-status-bot/cloud/overview", {options: {format: "text"}});
                                }
                            }
                        });
                    }
                }
            );
        });
    }

    function checkServer(region, req = false, callback = function (status, text) {}) {
        if (USE_CROWD) {
            var url = 'http://cmmcd.com/PokemonGo/';
            var start = new Date().getTime();
            request(url, function (error, response, text) {
                console.log(region + ": took " + timeConversion(new Date().getTime() - start) + " to load crowd");
                if (!error) {
                    var $ = cheerio.load(text);
                    $('.jumbotron table tr td h2').filter(function () {
                        var data = $(this);
                        var text = data.text();
                        var status = data.children().first().text();

                        console.log(region + ": check crowd server: " + text);
                        if (req) {
                            updateGlance(req, status, text);
                        } else {
                            updateGlances(status, text, region);
                        }
                        callback(status, text);
                    });
                } else {
                    callback("404", "http://cmmcd.com/PokemonGo/ is not available");
                }
            });
        } else {
            var url = 'http://www.mmoserverstatus.com/pokemon_go';
            var start = new Date().getTime();
            request(url, function (error, response, text) {
                console.log(region + ": took " + timeConversion(new Date().getTime() - start) + " to load non-crowd");
                if (!error) {
                    var $ = cheerio.load(text);
                    var gameFast = true;
                    var checkGame = false;
                    $('.counter ul li').filter(function () {
                        var data = $(this);
                        if (data.text().includes("Game stable")) {
                            var i = data.children().last().children().last();
                            gameFast = i.hasClass('fa fa-check green');
                            checkGame = true;
                        }
                        if (data.text().toLowerCase().includes(region)) {
                            if (checkGame) {
                                // console.log("checked game first");
                            } else {
                                // console.log("didn't check game first");
                            }
                            var i = data.children().last().children().last();
                            var status = "";
                            var text = "";
                            if (i.hasClass('fa fa-check green')) {
                                if (gameFast) {
                                    status = "Online!";
                                    text = 'Pokémon Go Server Status: Online!'
                                } else {
                                    status = "Laggy";
                                    text = "Pokémon Go Server Status: Online but possibly laggy or unstable!"
                                }
                            } else {
                                status = "Offline!";
                                text = 'Pokémon Go Server Status: Offline! (or very unstable)'
                            }
                            console.log(region + ": check non crowd server: " + text);
                            if (req) {
                                updateGlance(req, status, text);
                            } else {
                                updateGlances(status, text, region);
                            }
                            callback(status, region.capitalize() + " " + text);
                        }
                    });
                } else {
                    callback("404", "http://www.mmoserverstatus.com/pokemon_go is not avaliable")
                }
            });
        }
    }

    function getData(req, callback = function (data) {}) {
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        addon.settings.get(roomId, clientId).then(function (data) {
            callback(data);
        });
    }

    function setData(req, data) {
        var clientId = req.body.oauth_client_id;
        var roomId = req.body.item.room.id;
        addon.settings.set(roomId, data, clientId);
    }

// Notify the room that the add-on was installed. To learn more about
// Connect's install flow, check out:
// https://developer.atlassian.com/hipchat/guide/installation-flow
    addon.on('installed', function (clientKey, clientInfo, req) {
        var clientId = req.body.oauthId;
        var roomId = req.body.roomId;
        // intervals[clientId] = intervals[clientId] || {};
        // intervals[clientId][roomId] = intervals[clientId][roomId] || false;
        addon.settings.get(roomId, clientId).then(function (data) {
            data = {version: VERSION, pings: [], muted: []};
            addon.settings.set(roomId, data, clientId);
        });
        hipchat.getRoom(clientInfo, roomId).then(function (res) {
            if (res.statusCode == 200) {
                addInstalledRoom(clientInfo, clientId, res.body);
            }
            hipchat.sendMessage(clientInfo, roomId, 'The ' + addon.descriptor.name + ' add-on has been installed in this room').then(function (data) {
                hipchat.sendMessage(clientInfo, roomId, "use /help to find out what I do").then(function () {
                    hipchat.sendMessage(clientInfo, roomId, "Changelog: You can now select which regions server to check by using '/select'. Use '/regions' to find supported regions.<br/>" +
                        "This is probably super buggy, so if the bot is spammy or your not getting messages, send me an email at 'pokemongohipchatbot@gmail.com'");
                });
            });
        });
        checkServer("united states", {
            body: {
                oauth_client_id: clientId,
                item: {room: {id: roomId}}
            }
        }, function (status, text) {
            lastStatus = status;
        });
    });

// Clean up clients when uninstalled
    addon.on('uninstalled', function (id) {
        getInstalledRooms(function (rooms) {
            rooms.forEach(function (room) {
                if (room.clientId == id) {
                    removeInstalledRoom(room);
                }
            });
        });
        addon.settings.client.keys(id + ':*', function (err, rep) {
            rep.forEach(function (k) {
                addon.logger.info('Removing key:', k);
                addon.settings.client.del(k);
            });
        });
    });

    getActiveRooms(false, function (rooms) {
        if (rooms.length > 0) {
            startInterval();
        }
    });

    getInstalledRooms(function (rooms) { // update rooms
        for (var room of rooms) {
            client.hgetall(["installed" + room.id], function (err, reply) {
                if (!reply.region) {
                    console.log(reply);
                    client.hset(["installed" + room.id, "region", "united states"], function (err, reply) {

                    })
                }
            });
            client.hgetall([room.id], function (err, reply) {
                if (reply) {
                    if (!reply.region) {
                        reply.clientInfoJson = "hidden";
                        console.log(reply);
                        client.hset([room.id, "region", "united states"], function (err, reply) {

                        })
                    }
                }
            });
            // changeRegion(room, "united states", function (newRegion) {
            // });
        }
    });
    // sendMessageToAll("Hey, I just updated this bot to support different region servers so you should uninstall and reinstall this bot.<br/>Heres the link: <a href='https://marketplace.atlassian.com/plugins/pokemon-go-server-status-bot/server/overview'>https://marketplace.atlassian.com/plugins/pokemon-go-server-status-bot/server/overview</a>");
};

function getRoomRegion(room, callback = function (region) {}) {
    client.hget(["installed" + room.id, "region"], function (err, reply) {
        if (err) {
            console.log("error with getting rooms region");
            console.log(err);
            callback("united states");
        } else {
            callback(reply);
        }
    });
}

function getValidRegions() {
    return VALID_REGIONS;
}

function validRegion(region) {
    return getValidRegions().includes(region);
}

function changeRegion(room, region, callback = function (newRegion) {}) {
    getRoomRegion(room, function (oldRegion) {
        if (region == oldRegion) {
            callback(false);
        } else {
            isRoomListening(room, function (listening) {
                if (listening) {
                    updateListeningRegion(room, oldRegion, region, function () {
                        updateInstalledRegion(room, region, function () {
                            callback(region);
                        })
                    });
                } else {
                    updateInstalledRegion(room, region, function () {
                        callback(region);
                    })
                }
            });
        }
    });
}

function getActiveRooms(region = false, callback = function (rooms) {}) {
    var rooms = [];
    if (!region) {
        region = "listening";
    }
    client.smembers(region, function (err, reply) {
        async.each(reply, function (roomId, cb) {
            client.hgetall(roomId, function (err, room) {
                room.clientInfo = JSON.parse(room.clientInfoJson);
                rooms.push(room);
                cb();
            });
        }, function (err) {
            if (err) {
                console.log("error in get active rooms");
                console.log(err);
            }
            callback(rooms);
        });
    });
}

function stopRoomListening(room, callback = function (removed) {}) {
    isRoomListening(room, function (listening) {
        if (listening) {
            var done = false;
            client.srem(["listening", room.id], function (err, reply) {
                client.del(room.id);
                console.log("room: " + room.name + " has stopped listening");
                if (done) {
                    callback(true);
                } else {
                    done = true;
                }
            });
            getRoomRegion(room, function (region) {
                client.srem([region, room.id], function (err, reply) {
                    client.scard([region], function (err, reply) {
                        if (reply == 0) {
                            client.srem(["regions", region], function (err, reply) {
                                if (done) {
                                    callback(true);
                                } else {
                                    done = true;
                                }
                            });
                        } else {
                            if (done) {
                                callback(true);
                            } else {
                                done = true;
                            }
                        }
                    });
                });
            });
        } else {
            callback(false);
        }
    });
}

function getListeningRegions(callback = function (regions) {}) { // [regions]
    client.smembers(["regions"], function (err, regions) {
        callback(regions);
    });
}


function updateListeningRegion(room, oldRegion, region, callback = function () {}) {
    var done = false;
    client.srem([oldRegion, room.id], function (err, reply) {
        client.scard([oldRegion], function (err, reply) {
            if (reply == 0) {
                client.srem(["regions", oldRegion], function (err, reply) {
                    if (done) {
                        callback();
                    } else {
                        done = true;
                    }
                });
            } else {
                if (done) {
                    callback();
                } else {
                    done = true;
                }
            }
        });
    });
    client.sadd([region, room.id], function (err, reply) {
        client.sadd(["regions", region], function (err, reply) {
            client.hset([room.id, "region", region], function (err, reply) {
                if (done) {
                    callback();
                } else {
                    done = true;
                }
            });
        });
    });
}

function updateInstalledRegion(room, region, callback = function () {}) {
    client.hset("installed" + room.id, "region", region, function (err, reply) {
        callback();
    });
}

function removeInstalledRoom(room, callback = function () {}) {
    stopRoomListening(room, function (removed) {
        client.del(["installed" + room.id], function (err, reply) {
            client.srem("installedRoomIds", room.id, function (err, reply) {
                callback();
            });
        });
    });
}

function addInstalledRoom(clientInfo, clientId, room) {
    client.sadd(["installedRoomIds", room.id], function (err, reply) {
        if (err) {
            console.log("error in add installed room");
            console.log(err);
        } else {
            client.hmset(["installed" + room.id, "id", room.id, "clientId", clientId, "name", room.name, "region", "united states"], function (err, reply) {});
            console.log("installed room: " + room.name + " id: " + room.id);
            isRoomListening(room, function (listening) {
                if (listening) {
                    client.hmset([room.id, "clientInfoJson", JSON.stringify(clientInfo)], function (err, reply) {});
                }
            });
        }
    });
}
function isRoomListening(room, callback = function (listening) {}) {
    client.sismember(["listening", room.id], function (err, reply) {
        callback(reply == 1);
    });
}

function getInstalledRooms(callback = function (rooms) {}) {
    var rooms = [];
    client.smembers("installedRoomIds", function (err, reply) {
        async.each(reply, function (roomId, cb) {
            client.hgetall("installed" + roomId, function (err, room) {
                rooms.push(room);
                cb();
            });
        }, function (err) {
            if (err) {
                console.log("error in get installed rooms");
                console.log(err);
            }
            callback(rooms);
        });
    });
}

String.prototype.replaceAll = function (search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, 'g'), replacement);
};

String.prototype.capitalize = function () {
    return this.replace(/\w\S*/g, function (tStr) {
        return tStr.charAt(0).toUpperCase() + tStr.substr(1).toLowerCase();
    });
};

function timeConversion(millisec) {
    var seconds = (millisec / 1000).toFixed(2);
    var minutes = (millisec / (1000 * 60)).toFixed(2);
    var hours = (millisec / (1000 * 60 * 60)).toFixed(2);
    var days = (millisec / (1000 * 60 * 60 * 24)).toFixed(2);

    if (seconds < 60) {
        return seconds + " Seconds";
    } else if (minutes < 60) {
        return minutes + " Minutes";
    } else if (hours < 24) {
        return hours + " Hours";
    } else {
        return days + " Days"
    }
}
