import 'dart:io';
import 'package:web_socket_channel/io.dart';
import 'secure_token_storage.dart';

Future<IOWebSocketChannel> connectSecure(String url) async {
  final token = await SecureTokenStorage.read();
  if (token == null) {
    throw StateError('no API token');
  }
  final client = HttpClient()..badCertificateCallback = (cert, host, port) => false;
  final ws = IOWebSocketChannel.connect(
    Uri.parse(url.replaceFirst('ws://', 'wss://')),
    headers: {'Authorization': 'Bearer $token'},
    customClient: client,
  );
  return ws;
}
