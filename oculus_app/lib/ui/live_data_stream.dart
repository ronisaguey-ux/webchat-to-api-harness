import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';
import '../src/services/secure_token_storage.dart';

Future<WebSocketChannel> _connectLiveStream() async {
  final _wsUrl = Uri.parse(
    const String.fromEnvironment('OCULUS_WS_URL', defaultValue: 'wss://localhost:8443/live')
  );
  if (_wsUrl.scheme != 'wss') {
    throw StateError('Refusing plaintext live trading stream');
  }
  final token = await SecureTokenStorage.read();
  return IOWebSocketChannel.connect(
    _wsUrl,
    headers: {'Authorization': 'Bearer ${token ?? ''}'},
  );
}

void _onNewTick(Map<String, dynamic> tick) {
    setState(() {
      _ticks.add(tick);
      // Decimate to 500 points max to avoid chart redraw overhead
      if (_ticks.length > 500) {
        _ticks = DataDecimator.lttb(_ticks, 500);
      }
    });
  }
