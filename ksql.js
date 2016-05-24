/*
 Copyright 2016 Brendan Burns All rights reserved.

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

var alasql = require('alasql');
var fs = require('fs');
var http = require('http');
var Client = require('node-kubernetes-client');
var path = require('path');
var q = require('q');
var readline = require('readline-history');
var Table = require('cli-table2');
var url = require('url');

var client = new Client({
    host:  '10.0.0.1:8080',
    protocol: 'http',
    version: 'v1',
});

var mybase = new alasql.Database('mybase');

var create_tables = function(db) {
    db.exec('CREATE TABLE pods (uid TEXT, node TEXT, metadata Object, spec Object, status Object)');
    db.exec('CREATE TABLE nodes (name TEXT, uid TEXT, metadata Object, spec Object, status Object)');
    db.exec('CREATE TABLE services (name TEXT, uid TEXT, metadata Object, spec Object, status Object)');
    db.exec('CREATE TABLE containers (image TEXT, uid TEXT, restarts INT)');
};

var process_result = function(res) {
    var headers = [];
    for (var field in res[0]) {
	headers.push(field);
    }
    var table = [];
    for (var i = 0; i < res.length; i++) {
	var data = [];
	for (field in res[i]) {
	    data.push(res[i][field]);
	}
	table.push(data);
    }
    return {
	'headers': headers,
	'data': table
    };
};

var handle_next = function(rli) {
    rli.setPrompt('> ');
    rli.prompt();
    rli.on('line', function(line) {
	if (line && line.length != 0) {
	    try {
		var res = mybase.exec(line);
		if (res.length == 0) {
		    console.log("[]");
		} else {
		    var data = process_result(res);
		    var tbl = new Table({
			head: data.headers
		    });
		    for (var i = 0; i < data.data.length; i++) {
			tbl.push(data.data[i]);
		    }
		    console.log(tbl.toString());
		}
	    } catch (ex) {
		console.log(ex);
	    }
	}
	rli.prompt();
    }).on('close', function() {
	console.log('shutting down.');
	process.exit(0);
    });
};

var load_pods = function() {
    var defer = q.defer();
    client.pods.get(function (err, pods) {
	var containers = [];
	for (var i = 0; i < pods[0].items.length; i++) {
	    var pod = pods[0].items[i];
	    pod.uid = pod.metadata.uid;
	    pod.node = pod.spec.nodeName;
	    for (var j = 0; j < pod.spec.containers.length; j++) {
		var container = pod.spec.containers[j];
		var restarts = 0;
		if (pod.status.containerStatuses[j].restartCount) {
		    restarts = pod.status.containerStatuses[j].restartCount;
		}
		containers.push({
		    'image': container.image,
		    'uid': pod.metadata.uid,
		    'restarts': pod.status.containerStatuses[j].restartCount
		});
	    }
	}
	alasql.databases.mybase.tables.containers.data = containers;
	alasql.databases.mybase.tables.pods.data = pods[0].items;
	defer.resolve();
    });
    return defer.promise;
}

var generic_load = function(fn, db) {
    var defer = q.defer();
    fn(function(err, result) {
	for (var i = 0; i < result[0].items.length; i++) {
	    var res = result[0].items[i];
	    res.uid = res.metadata.uid;
	    res.name = res.metadata.name;
	}
	db.data = result[0].items;
	defer.resolve();
    });
    return defer.promise;
};

var load_services = function() {
    return generic_load(client.services.get, alasql.databases.mybase.tables.services);
};

var load_nodes = function() {
    return generic_load(client.nodes.get, alasql.databases.mybase.tables.nodes);
};

var load = function () {
    return q.all([
	load_pods(),
	load_nodes(),
	load_services()
    ])
};

create_tables(mybase);

load().then(function() {
    var rl = readline.createInterface({
	path: "/tmp/ksql-history",
	input: process.stdin,
	output: process.stdout,
	maxLength: 100,
	next: handle_next
    });
    setTimeout(load, 10000);
});

var handle_request = function(req, res) {
    var u = url.parse(req.url, true);
    if (u.pathname.startsWith('/api')) {
	handle_api_request(req, res, u);
    } else {
	handle_static_request(u, res);
    }
};

var handle_api_request = function(req, res, u) {
    var query = u.query['query'];
    if (query) {
	try {
	    var qres = mybase.exec(query);
	    res.setHeader('Content-Type', 'application/json')
	    res.statusCode = 200;
	    var obj = [];
	    if (qres.length > 0) {
		obj = process_result(qres);
	    }
	    res.end(JSON.stringify(obj, null, 2));
	} catch (ex) {
	    res.statusCode = 500;
	    res.end('error: ' + ex);
	}
    } else {
	res.statusCode = 400;
	res.end('missing query');
    }
};

var handle_static_request = function(u, res) {
    var fp = '.' + u.pathname;
    if (fp == './' || fp == '.') {
	fp = './index.html';
    }
    if (fp.indexOf('..') != -1) {
	res.statusCode = 400;
	res.end('.. is not allowed in paths');
	return;
    }
    var contentType = 'text/plain';
    switch (path.extname(fp)) {
    case '.js':
	contentType = 'text/javascript';
	break;
    case '.css':
	contentType = 'text/css';
	break;
    case '.html':
	contentType = 'text/html';
	break;
    }

    fs.readFile(fp, function(err, content) {
	if (err) {
	    if (err.code == 'ENOENT') {
		res.statusCode = 404;
		res.end('file not found: ' + fp);
	    } else {
		res.statusCode = 500;
		res.end('internal error: ' + err);
	    }
	    return;
	}
	res.writeHead(200, { 'Content-Type': contentType });
	res.end(content, 'utf-8');
    });
};

var server = http.createServer(handle_request);

server.listen(8090, function() {
    console.log('Server running on localhost:8080');
});


