var http = require("http");
var url = require("url");
var jsdom = require("jsdom").jsdom();
var fs = require("fs");
var querystring = require("querystring");
var exec = require("child_process").exec;
var parseCookies = require("cookie").parse;

var decoder_configuration = require("./decoder_configuration.js");
	// options.secret_key_base = process.env.USER;	//we can set here secret_key_base
var cookieDecoder = require("cookieDecoder")(decoder_configuration);
var ChartsMap = require("./service.js")();	//TODO - zienic zeby modul eksportowal mape a nie funkcje, albo przekazywac handlery
var DataRetriever = require("./data_retriever.js");
var LoadBalancerRegistration = require("./load_balancer_registration.js");

var config = require("./config.js");
var panel_locals = require("./panel_locals.js");

var jade = require("jade");
var METHODS_DIR = "./visualisation_methods";

var log4js = require("log4js");
log4js.configure({
  appenders: [
    { type: 'file', filename: config.log_filename, category: ['console', 'server.js'] }
  ],
  replaceConsole: true
});
var logger = log4js.getLogger("server.js");

// var PORT = config.server_port,
	// EXTERNAL_IP = config.server_ip,// + ":3001",			//TODO - retrieve external IP
	// ADDRESS = EXTERNAL_IP + config.server_prefix;		//address suffix set in /etc/nginx/conf.d/default.conf
var PORT = config.server_port;
var PREFIX = config.server_prefix;

var requests_map = prepare_map_with_requests();
var app = http.createServer(function(req, res) {
	var parsedUrl = url.parse(req.url);
	var pathname = parsedUrl.pathname;
	var parameters = querystring.parse(parsedUrl.query);
	logger.info(pathname + " : " +JSON.stringify(parameters));

	var path = pathname.split("/")[1];
	if(requests_map[path]) {
        authenticate(req.headers, function (userID) {
            requests_map[path](req, res, pathname, parameters["id"]);
        }, function (err) {
            logger.error("Authentication failed: " + err);
            res.writeHead(401);
            res.write(err.toString());
            res.end();
        });
    }
	else if(ChartsMap[path]) {
		ChartsMap[path](parameters, function(object) {
			authenticate(req.headers, function(userID) {
                DataRetriever.checkIfExperimentVisibleToUser(userID, parameters["id"], function() {
                    logger.info("OK! Successfully authorized.");
                    //res.writeHead(200, {'Content-Type': 'text/plain'});
                    var output = jade.renderFile(path_to_view_template(path), parameters);
					output += object.content;
                    res.write(output);
                    res.end();
                }, function(err){
                    logger.error("User " + userID + " doesn't have access to experiment " + parameters["id"]);
                    res.write("User " + userID + " doesn't have access to experiment " + parameters["id"]);
                    res.end();
                })
			}, function(err) {
				console.log("FAILED! Sending info about error to Scalarm... \n" + err);
				res.write("Unable to authenticate");
				res.end();
			});
		}, function(err) {
			res.write(err);
			res.end();
			return;
		});
	}
	else {
		res.writeHead(404);
		res.write(pathname + " : incorrect request!");
		res.end();
	}
});

LoadBalancerRegistration.retrieveDBAddress(function(address) {
    DataRetriever.connect(address, function(){
        app.listen(PORT, function(){
            LoadBalancerRegistration.registerChartService(function(){
            	logger.trace("ChartService registered");
            });
            logger.trace("Listening on port " + PORT);
        });
    }, function(){
        logger.error("Connection to database failed");
        throw new Error("Connection to database failed");
    })
});


var WebSocketServer = require('websocket').server;
wsServer = new WebSocketServer({
	httpServer: app
})

wsServer.on('request', function(request) {
	logger.info(" Connection from origin " + request.origin);
	var experimentID = request.httpRequest.url.slice(1);
	authenticate(request.httpRequest.headers, function(userID) {
		logger.info("OK! Successfully authorized.");
        DataRetriever.checkIfExperimentVisibleToUser(userID, experimentID, function(){
            var connection = request.accept(null, request.origin);

            connection.on('close', function(connection) {
                logger.info("Connection closed");
                //TODO - close cursor?
            });

            DataRetriever.createStreamFor(connection, experimentID, function(stream){
            	connection.on('close', function(connection){
            		console.log("Connection closed");
            		stream.destroy();
            	});
            });
        }, function(){
            console.log("Error checking experiment's affiliation");
            request.reject();
        });
	}, function(err) {
		console.log("Authentication failed! \n" + err);
		request.reject();
	});
});

//--------------------------------
function authenticate(headers, success, error){
    var cookies = headers.cookie;
    if(cookies) {
    	var cookie = parseCookies(cookies)["_scalarm_session"];
        var output = cookieDecoder(cookie);

        //maybe try without exec...?
        exec("ruby serialized_object_to_json.rb " + new Buffer(output).toString("base64"), function(err, stdout, stderr) {
            if (err !== null) {
                console.log('stderr: ' + stderr);
                console.log('exec error: ' + err);
                error(err);
                return;
            }
            var userID = JSON.parse(stdout)["user"];
            success(userID);
        });
    }
    else {
        var header=headers['authorization']||'';            // get the header
        if(!header){
            console.log("No authentication credentials")
            error("No authentication credentials");
        }
        var token=header.split(/\s+/).pop()||'',            // and the encoded auth token
            auth=new Buffer(token, 'base64').toString(),    // convert from base64
            parts=auth.split(":"),                          // split on colon
            username=parts[0],
            password=parts[1];

        var crypto = require('crypto');
        DataRetriever.checkUserAndPassword(username, password, success, error);
    	
    }
}

function prepare_script_and_style_tags(typeOfChart) {
	var tags = {};
	tags.script_tag_main = jsdom.createElement("script");
	tags.script_tag_main.setAttribute("type", "text/javascript");
	tags.script_tag_main.setAttribute("src", PREFIX +"/main"+ typeOfChart);

    return tag;
}
function prepare_map_with_requests() {
	var map = {};
	map["panel"] = function(req, res, _, experimentID){
		DataRetriever.getParameters(experimentID, function(data) {
			panel_locals.parameters = data.parameters;
			panel_locals.output = data.result;
            panel_locals.parameters_and_output = data.parameters.concat(data.result);
			// panel_locals.address = ADDRESS;
			panel_locals.prefix = PREFIX;
			res.writeHead(200);
			var panel = jade.renderFile("panel.jade", panel_locals);
			res.write(panel);
			res.end();
		},
		function(err) {
			res.writeHead(404);
			res.write("Error getting parameters\n");
			res.write(err+"\n");
			res.end();
		})
	};

	map["images"] = function(req, res, pathname) {
		fs.readFile('.'+pathname, function(error, data) {
			if(error) {
				res.writeHead(404);
				res.write("File " + pathname + " : not found!\n");
				res.write(error.toString());
				res.end();
			}
			else {
				res.write(data);
				res.end();
			}
		});
	};

	map["main"] = function(req, res, pathname){
		var type = pathname.split("/")[2];
		var resource = pathname.split("/")[1];

		var file_path = [METHODS_DIR, type, type+"_chart_"+resource].join("/");
		file_path += resource==="style" ? ".css" : ".js";

		fs.readFile(file_path, function(error, data) {
			if(error) {
				res.writeHead(404);
				res.write("File " + file_path + " : not found!\n");
				res.write(error.toString());
				res.end();
			}
			else {
				res.write(data);
				res.end();
			}
		});
	};

	map["scripts"] = function(req, res, pathname){
		var chart_type = pathname.split("/")[2];
		var tag = prepare_script_tag(chart_type);

		res.write(tag.outerHTML);
		res.end();
	};

	map["status"] = function(req, res, pathname) {
		res.write("status ok");
		res.end();
	}

	return map;
}

function path_to_view_template(path) {
	return [METHODS_DIR, path, path+"Chart.jade"].join("/");
}
