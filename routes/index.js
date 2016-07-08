var http = require('request');
var cors = require('cors');
var uuid = require('uuid');
var url = require('url');

var fs = require('fs');
var request = require('request');
var cheerio = require('cheerio');

var lastStatus;
var interval;
var REFRESH_RATE = 10 * 1000; // 10 seconds

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
            res.json({
                "label": {
                    "type": "html",
                    "value": "Server status here!"
                },
                "status": {
                    "type": "lozenge",
                    "value": {
                        "label": "TODO",
                        "type": "error"
                    }
                }
            });
        }
    );

    // This is an example end-point that you can POST to to update the glance info
    // Room update API: https://www.hipchat.com/docs/apiv2/method/room_addon_ui_update
    // Group update API: https://www.hipchat.com/docs/apiv2/method/addon_ui_update
    // User update API: https://www.hipchat.com/docs/apiv2/method/user_addon_ui_update
    app.post('/update_glance',
        cors(),
        addon.authenticate(),
        function (req, res) {
            res.json({
                "label": {
                    "type": "html",
                    "value": "Server status here!"
                },
                "status": {
                    "type": "lozenge",
                    "value": {
                        "label": "TODO",
                        "type": "success"
                    }
                }
            });
        }
    );

    // This is an example sidebar controller that can be launched when clicking on the glance.
    // https://developer.atlassian.com/hipchat/guide/dialog-and-sidebar-views/sidebar
    app.get('/sidebar',
        addon.authenticate(),
        function (req, res) {
            res.render('sidebar', {
                identity: req.identity
            });
        }
    );

    // This is an example dialog controller that can be launched when clicking on the glance.
    // https://developer.atlassian.com/hipchat/guide/dialog-and-sidebar-views/dialog
    app.get('/dialog',
        addon.authenticate(),
        function (req, res) {
            res.render('dialog', {
                identity: req.identity
            });
        }
    );

    // Sample endpoint to send a card notification back into the chat room
    // See https://developer.atlassian.com/hipchat/guide/sending-messages
    app.post('/send_notification',
        addon.authenticate(),
        function (req, res) {
            var card = {
                "style": "link",
                "url": "https://www.hipchat.com",
                "id": uuid.v4(),
                "title": req.body.messageTitle,
                "description": "Great teams use HipChat: Group and private chat, file sharing, and integrations",
                "icon": {
                    "url": "https://hipchat-public-m5.atlassian.com/assets/img/hipchat/bookmark-icons/favicon-192x192.png"
                }
            };
            var msg = '<b>' + card.title + '</b>: ' + card.description;
            var opts = {'options': {'color': 'yellow'}};
            hipchat.sendMessage(req.clientInfo, req.identity.roomId, msg, opts, card);
            res.json({status: "ok"});
        }
    );

    // This is an example route to handle an incoming webhook
    // https://developer.atlassian.com/hipchat/guide/webhooks
    app.post('/webhook',
        addon.authenticate(),
        function (req, res) {
            // console.log(req.body);
            console.log(req.body.item.message.message);
            hipchat.sendMessage(req.clientInfo, req.identity.roomId, 'pong pong')
                .then(function (data) {
                    res.sendStatus(200);
                });
        }
    );

    app.post('/server',
        addon.authenticate(),
        function (req, res) {
            console.log(req.body.item.message.message);

            checkServer(req, function (status, text) {
                sendMessage(req, text);
                if (!interval && status.includes("Offline") || status.includes("Unstable")) {
                    lastStatus = status;
                    interval = setInterval(function () {
                        checkServer(req, function (status, text) {
                            if (status.includes("Unstable") && lastStatus.includes("Offline")) {
                                sendMessage(req, text);
                            }
                            if (status.includes("Offline") && lastStatus.includes("Unstable")) {
                                sendMessage(req, text);
                            }
                            if (status.includes("Online")) {
                                console.log("stopped interval");
                                clearInterval(interval);
                                interval = false;
                                sendMessage(req, text);
                            }
                            lastStatus = status;
                        });
                    }, REFRESH_RATE);
                }
            });
            // sendMessage(req, "called server", function (data) {
            //     res.sendStatus(200);
            // });

            // hipchat.sendMessage(req.clientInfo, req.identity.roomId, 'called server')
            //     .then(function (data) {
            //         res.sendStatus(200);
            //     });
        }
    );

    function sendMessage(req, message, callback = false) {
        hipchat.sendMessage(req.clientInfo, req.identity.roomId, message)
            .then(function (data) {
                if (callback) {
                    callback(data);
                }
            });
    }

    // callback(status, text)
    function checkServer(req, callback = false) {
        url = 'http://cmmcd.com/PokemonGo/';
        request(url, function (error, response, text) {
            if (!error) {
                console.log("in check server");
                var $ = cheerio.load(text);
                var status;
                $('.jumbotron table tr td h2').filter(function () {
                    var data = $(this);
                    text = data.text();

                    status = data.children().first().text();

                    console.log(text);
                    callback(status, text);
                });
            }
        });
    }

    // Notify the room that the add-on was installed. To learn more about
    // Connect's install flow, check out:
    // https://developer.atlassian.com/hipchat/guide/installation-flow
    addon.on('installed', function (clientKey, clientInfo, req) {
        hipchat.sendMessage(clientInfo, req.body.roomId, 'The ' + addon.descriptor.name + ' add-on has been installed in this room').then(function(data) {
            hipchat.sendMessage(clientInfo, req.body.roomId, 'use "/server" to use me');
        });
        checkServer({clientInfo: clientInfo}, function (status, text) {
            lastStatus = status;
        });
    });

    // Clean up clients when uninstalled
    addon.on('uninstalled', function (id) {
        addon.settings.client.keys(id + ':*', function (err, rep) {
            rep.forEach(function (k) {
                addon.logger.info('Removing key:', k);
                addon.settings.client.del(k);
            });
        });
    });

};

String.prototype.replaceAll = function (search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, 'g'), replacement);
};
