var sys = require('sys');
var http = require('http');
var util = require('util');
var events = require('events');
var JsonParser = require('jsonparse');

var METHOD_NOT_ALLOWED = "Method Not Allowed\n";
var INVALID_REQUEST = "Invalid Request\n";


//===----------------------------------------------------------------------===//
// JSON-RPC HTTP Client
//===----------------------------------------------------------------------===//
var Client = function (port, host, user, password) {
  this.port = port;
  this.host = host;
  this.user = user;
  this.password = password;

  this.raw = function raw(method, params, opts, callback) {
    if ("function" === typeof opts) {
      callback = opts;
      opts = {};
    }
    opts = opts || {};

    var client = http.createClient(port, host);

    var id = 1;

    // First we encode the request into JSON
    var requestJSON = JSON.stringify({
      'id': id,
      'method': method,
      'params': params
    });
    
    var headers = {};

    if (user && password) {
      var buff = new Buffer(this.user + ":" + this.password)
                           .toString('base64');
      var auth = 'Basic ' + buff;
      headers['Authorization'] = auth;
    }

    // Then we build some basic headers.
    headers['Host'] = host;
    headers['Content-Length'] = requestJSON.length;

    // Report errors from the http client. This also prevents crashes since an exception is thrown if we don't handle this event.
    client.on('error', function(err) {
      callback(err);
    });

    // Now we'll make a request to the server
    var request = client.request('POST', opts.path || '/', headers);
    request.write(requestJSON);
    request.on('response', callback.bind(this, id, request));
  };

  this.stream = function (method, params, opts, callback) {
    if ("function" === typeof opts) {
      callback = opts;
      opts = {};
    }
    opts = opts || {};

    this.raw(method, params, opts, function (id, request, response) {
      if ("function" === typeof callback) {
        var connection = new events.EventEmitter();
        connection.id = id;
        connection.req = request;
        connection.res = response;
        connection.expose = function (method, callback) {
          connection.on('call:'+method, function (data) {
            callback.call(null, data.params || []);
          });
        };
        connection.end = function () {
          this.req.connection.end();
        };

        // We need to buffer the response chunks in a nonblocking way.
        var parser = new JsonParser();
        parser.onValue = function (decoded) {
          if (this.stack.length) return;

          connection.emit('data', decoded);
          if (decoded.hasOwnProperty('result') || 
              decoded.hasOwnProperty('error') &&
              decoded.id === id &&
              "function" === typeof callback) {
            connection.emit('result', decoded);
          } else if (decoded.hasOwnProperty('method')) {
            connection.emit('call:'+decoded.method, decoded);
          }
        };
        // Handle headers
        connection.res.once('data', function (data) {
          if (connection.res.statusCode === 200) {
            callback(null, connection);
          } else {
            callback(new Error(""+connection.res.statusCode+" "+data));
          }
        });
        connection.res.on('data', function (chunk) {
          try {
            parser.write(chunk);
          } catch(err) {
            // TODO: Is ignoring invalid data the right thing to do?
          }
        });
        connection.res.on('end', function () {
          // TODO: Issue an error if there has been no valid response message
        });
      }
    });
  };
  this.call = function (method, params, opts, callback) {
    if ("function" === typeof opts) {
      callback = opts;
      opts = {};
    }
    opts = opts || {};
    this.raw(method, params, opts, function (id, request, response) {
      var data = '';
      response.on('data', function (chunk) {
        data += chunk;
      });
      response.on('end', function () {
        if (response.statusCode !== 200) {
          callback(new Error(""+response.statusCode+" "+data));
          return;
        }
        var decoded = JSON.parse(data);
        if ("function" === typeof callback) {
          if (!decoded.error) {
            decoded.error = null;
          }
          callback(decoded.error, decoded.result);
        }
      });
    });
  };
};

//===----------------------------------------------------------------------===//
// JSON-RPC HTTP Server
//===----------------------------------------------------------------------===//
function Server() {
  var self = this;
  this.functions = {};
  this.scopes = {};
  this.defaultScope = this;
  this.server = http.createServer(function(req, res) {
    Server.trace('<--', 'accepted request');
    if(req.method === 'POST') {
      self.handlePOST(req, res);
    }
    else {
      Server.handleNonPOST(req, res);
    }
  });
}


//===----------------------------------------------------------------------===//
// exposeModule
//===----------------------------------------------------------------------===//
Server.prototype.exposeModule = function(mod, object, scope) {
  var funcs = [];
  for(var funcName in object) {
    var funcObj = object[funcName];
    if(typeof(funcObj) == 'function') {
      this.functions[mod + '.' + funcName] = funcObj;
      funcs.push(funcName);

      if (scope) {
        this.scopes[mod + '.' + funcName] = scope;
      }
    }
  }
  Server.trace('***', 'exposing module: ' + mod + ' [funs: ' + funcs.join(', ') 
                + ']');
  return object;
}


//===----------------------------------------------------------------------===//
// expose
//===----------------------------------------------------------------------===//
Server.prototype.expose = function(name, func, scope) {
  Server.trace('***', 'exposing: ' + name);
  this.functions[name] = func;

  if (scope) {
    this.scopes[name] = scope;
  }
}


//===----------------------------------------------------------------------===//
// trace
//===----------------------------------------------------------------------===//
Server.trace = function(direction, message) {
  sys.puts('   ' + direction + '   ' + message);
}


//===----------------------------------------------------------------------===//
// listen
//===----------------------------------------------------------------------===//
Server.prototype.listen = function(port, host) { 
  this.server.listen(port, host);
  Server.trace('***', 'Server listening on http://' + (host || '127.0.0.1') + 
                ':' + port + '/'); 
}


//===----------------------------------------------------------------------===//
// handleServerError
//===----------------------------------------------------------------------===//
Server.handleServerError = function(req, res, code, message) {
  res.writeHead(400, {'Content-Type': 'text/plain',
                      'Content-Length': message.length});
  res.write(message);
  res.end();
}


//===----------------------------------------------------------------------===//
// handlePOST
//===----------------------------------------------------------------------===//
Server.prototype.handlePOST = function(req, res) {
  var buffer = '';
  var self = this;
  var handle = function (buf) {
    var decoded = JSON.parse(buf);

    var isStreaming = false;

    // Check for the required fields, and if they aren't there, then
    // dispatch to the handleServerError function.
    if(!(decoded.method && decoded.params && decoded.id)) {
      Server.trace('-->', 'response (invalid request)');
      Server.handleServerError(req, res, 400, INVALID_REQUEST);
      return;
    }

    if(!self.functions.hasOwnProperty(decoded.method)) {
      Server.trace('-->', 'response (unknown method "' + decoded.method + '")');
      Server.handleServerError(req, res, 400, "Unknown RPC call '"+decoded.method+"'");
      return;
    }

    var reply = function (json) {
      var encoded = JSON.stringify(json);

      if (!isStreaming) {
        res.writeHead(200, {'Content-Type': 'application/json',
                            'Content-Length': encoded.length});
        res.write(encoded);
        res.end();
      } else {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.write(encoded);
        // Keep connection open
      }
    };

    // Build our success handler
    var onSuccess = function(funcResp) {
      Server.trace('-->', 'response (id ' + decoded.id + '): ' + 
                    JSON.stringify(funcResp));

      reply({
        'result': funcResp,
        'error': null,
        'id': decoded.id
      });
    };

    // Build our failure handler (note that error must not be null)
    var onFailure = function(failure) {
      Server.trace('-->', 'failure: ' + JSON.stringify(failure));
      reply({
        'result': null,
        'error': failure || 'Unspecified Failure',
        'id': decoded.id
      });
    };

    Server.trace('<--', 'request (id ' + decoded.id + '): ' + 
                  decoded.method + '(' + decoded.params.join(', ') + ')');

    // Try to call the method, but intercept errors and call our
    // onFailure handler.
    var method = self.functions[decoded.method];
    var callback = function(err, result) {
      if (err) {
        onFailure(err);
      } else {
        onSuccess(result);
      }
    };
    // Can be called before the response callback to keep the connection open.
    var stream = function (onend) {
      isStreaming = true;

      if ("function" === typeof onend) {
        res.connection.on('end', onend);
      }
    };
    var emit = function (method, params) {
      if (!res.connection.writable) return;

      if (!Array.isArray(params)) {
        params = [params];
      }

      Server.trace('-->', 'emit (method '+method+'): ' + JSON.stringify(params));
      var data = JSON.stringify({
        method: method,
        params: params,
        id: null
      });
      res.write(data);
    };
    var scope = self.scopes[decoded.method] || self.defaultScope;

    // Other various information we want to pass in for the handler to be
    // able to access.
    var opts = {
      req: req,
      res: res,
      server: self,
      callback: callback,
      stream: stream,
      emit: emit
    };

    try {
      method.call(scope, decoded.params, opts, callback);
    } catch (err) {
      onFailure(err);
    }
  }; // function handle(buf)

  req.addListener('data', function(chunk) {
    buffer = buffer + chunk;
  });

  req.addListener('end', function() {
    handle(buffer);
  });
};


//===----------------------------------------------------------------------===//
// handleNonPOST
//===----------------------------------------------------------------------===//
Server.handleNonPOST = function(req, res) {
  res.writeHead(405, {'Content-Type': 'text/plain',
                      'Content-Length': METHOD_NOT_ALLOWED.length,
                      'Allow': 'POST'});
  res.write(METHOD_NOT_ALLOWED);
  res.end();
};

module.exports.Server = Server;
module.exports.Client = Client;
