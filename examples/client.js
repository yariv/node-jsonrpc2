var sys = require('sys');
var rpc = require('../src/jsonrpc');

rpc.Endpoint.trace = function () {};

var client = new rpc.Client(8088, 'localhost');

client.call('add', [1, 2], function (err, result) {
  sys.puts('  1 + 2 = ' + result);
});

client.call('multiply', [199, 2], function (err, result) {
  sys.puts('199 * 2 = ' + result);
});

// Accessing modules is as simple as dot-prefixing.
client.call('math.power', [3, 3], function (err, result) {
  sys.puts('  3 ^ 3 = ' + result);
});

// We can handle errors the same way as anywhere else in Node
client.call('add', [1, 1], function (err, result) {
  if (err) {
    sys.puts('RPC Error: '+ sys.inspect(err));
    return;
  }
  sys.puts('  1 + 1 = ' + result + ', dummy!');
});

// These calls should each take 1.5 seconds to complete
client.call('delayed.add', [1, 1, 1500], function (err, result) {
  sys.puts(result);
});

client.call('delayed.echo', ['Echo.', 1500], function (err, result) {
  sys.puts(result);
});

client.stream('listen', [], function (err, connection) {
  var counter = 0;
  connection.expose('event', function (params) {
    console.log('Streaming #'+counter+': '+params[0]);
    counter++;
    if (counter > 4) {
      connection.end();
    }
  });
  console.log('start listening');
});

var socketClient = new rpc.Client(8089, 'localhost');

socketClient.connectSocket(function (err, conn) {
  var counter = 0;
  socketClient.expose('event', function (params) {
    console.log('Streaming (socket) #'+counter+': '+params[0]);
    counter++;
    if (counter > 4) {
      conn.end();
    }
  });

  conn.call('listen', []);
});
