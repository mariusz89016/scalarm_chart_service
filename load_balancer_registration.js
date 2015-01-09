var config = require("./config.js");
var dgram = require("dgram");
var client = dgram.createSocket("udp4");
var fs = require("fs");
var https = require("https");
var LBaddress;

module.exports.retrieveDBAddress = function(callback) {
    client.bind(config.multicast_port);
    client.on("listening", function() {
        client.addMembership(config.multicast_address);
    });

    client.on("message", function(message, remote) {
        console.log("LB multicasted address: ", message.toString());
        if (LBaddress===undefined) {
            LBaddress = message.toString();
            var options = {
              host: LBaddress,
              path: '/information/db_routers',
              rejectUnauthorized: false
            };

            https.get(options, function(res) {
              var data = "";
              console.log("Got response: " + res.output);
              res.on("data", function(chunk) {
                data+=chunk;
              });
              res.on("end", function() {
                var addressDB = "mongodb://" + JSON.parse(data)[0] + "/scalarm_db";
                // var addressDB = "mongodb://172.16.67.30:27017/scalarm_db";
                console.log("Retrieved database address: ", addressDB);
		        client.close();
                callback(addressDB);
              })
            });
        }
    })

};

module.exports.registerChartService = function(callback){
//    var data = querystring.stringify({
//        name: "ChartService",
//        address: config.server_ip + ":" + config.server_port
//    });
    var data = new Buffer("name=ChartService&address="+config.server_ip+":"+config.server_port);

    var options = {
        host: LBaddress,
        port: 443,
        path: "/register?"+data,
        method: "POST",
        rejectUnauthorized: false
    };

    var post_req = https.request(options, function(response){
        response.on('data', function(chunk) {
            console.log(chunk.toString());
        })
    });

    post_req.end();
    callback();
};
