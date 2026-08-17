class SecureTokenStorage {
  static String? _token;

  static Future<void> write(String token) async {
    _token = token;
  }

  static Future<String?> read() async {
    return _token;
  }

  static Future<void> clear() async {
    _token = null;
  }
}
