require('./test').extend(global);

var sys = require('sys');
var rpc = require('../src/jsonrpc');

var server = new rpc.Server();

// MOCK REQUEST/RESPONSE OBJECTS
var MockRequest = function(method) {
  this.method = method;
  process.EventEmitter.call(this);
};
sys.inherits(MockRequest, process.EventEmitter);

var MockResponse = function() {
  process.EventEmitter.call(this);
  this.writeHead = this.sendHeader = function(httpCode, httpHeaders) {
    this.httpCode = httpCode;
    this.httpHeaders = httpCode;
  };
  this.write = this.sendBody = function(httpBody) {
    this.httpBody = httpBody; 
  };
  this.end = this.finish = function() {};
};
sys.inherits(MockResponse, process.EventEmitter);

// A SIMPLE MODULE
var TestModule = {
  foo: function (a, b) {
    return ['foo', 'bar', a, b];
  },

  other: 'hello'
};

// EXPOSING FUNCTIONS

test('Server.expose', function() {
  var echo = function(args, opts, callback) {
    callback(null, args[0]);
  };
  server.expose('echo', echo);
  assert(server.functions.echo === echo);
})

test('Server.exposeModule', function() {
  server.exposeModule('test', TestModule);
  sys.puts(server.functions['test.foo']);
  sys.puts(TestModule.foo);
  assert(server.functions['test.foo'] == TestModule.foo);
});

// INVALID REQUEST

test('GET Server.handleNonPOST', function() {
  var req = new MockRequest('GET');
  var res = new MockResponse();
  rpc.Server.handleNonPOST(req, res);
  assert(res.httpCode === 405);
});

function testBadRequest(testJSON) {
  var req = new MockRequest('POST');
  var res = new MockResponse();
  server.handlePOST(req, res);
  req.emit('data', testJSON);
  req.emit('end');
  sys.puts(res.httpCode);
  assert(res.httpCode === 400);
}

test('Missing object attribute (method)', function() {
  var testJSON = '{ "params": ["Hello, World!"], "id": 1 }';
  testBadRequest(testJSON);
});

test('Missing object attribute (params)', function() {
  var testJSON = '{ "method": "echo", "id": 1 }';
  testBadRequest(testJSON);
});

test('Missing object attribute (id)', function() {
  var testJSON = '{ "method": "echo", "params": ["Hello, World!"] }';
  testBadRequest(testJSON);
});

test('Unregistered method', function() {
  var testJSON = '{ "method": "notRegistered", "params": ["Hello, World!"], "id": 1 }';
  testBadRequest(testJSON);
});

// VALID REQUEST

test('Simple synchronous echo', function() {
  var testJSON = '{ "method": "echo", "params": ["Hello, World!"], "id": 1 }';
  var req = new MockRequest('POST');
  var res = new MockResponse();
  server.handlePOST(req, res);
  req.emit('data', testJSON);
  req.emit('end');
  assert(res.httpCode === 200);
  var decoded = JSON.parse(res.httpBody);
  assert(decoded.id === 1);
  assert(decoded.error === null);
  assert(decoded.result == 'Hello, World!');
});

test('Using promise', function() {
  // Expose a function that just returns a promise that we can control.
  var callbackRef = null;
  server.expose('promiseEcho', function(args, opts, callback) {
    callbackRef = callback;
  });
  // Build a request to call that function
  var testJSON = '{ "method": "promiseEcho", "params": ["Hello, World!"], "id": 1 }';
  var req = new MockRequest('POST');
  var res = new MockResponse();
  // Have the server handle that request
  server.handlePOST(req, res);
  req.emit('data', testJSON);
  req.emit('end');
  // Now the request has completed, and in the above synchronous test, we
  // would be finished. However, this function is smarter and only completes
  // when the promise completes.  Therefore, we should not have a response
  // yet.
  assert(res['httpCode'] == null);
  // We can force the promise to emit a success code, with a message.
  callbackRef(null, 'Hello, World!');
  // Aha, now that the promise has finished, our request has finished as well.
  assert(res.httpCode === 200);
  var decoded = JSON.parse(res.httpBody);
  assert(decoded.id === 1);
  assert(decoded.error === null);
  assert(decoded.result == 'Hello, World!');
});

test('Triggering an errback', function() {
  var callbackRef = null;
  server.expose('errbackEcho', function(args, opts, callback) {
    callbackRef = callback;
  });
  var testJSON = '{ "method": "errbackEcho", "params": ["Hello, World!"], "id": 1 }';
  var req = new MockRequest('POST');
  var res = new MockResponse();
  server.handlePOST(req, res);
  req.emit('data', testJSON);
  req.emit('end');
  assert(res['httpCode'] == null);
  // This time, unlike the above test, we trigger an error and expect to see
  // it in the error attribute of the object returned.
  callbackRef('This is an error');
  assert(res.httpCode === 200);
  var decoded = JSON.parse(res.httpBody);
  assert(decoded.id === 1);
  assert(decoded.error == 'This is an error');
  assert(decoded.result == null);
})
