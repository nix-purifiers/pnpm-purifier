# SPDX-License-Identifier: MIT
{ pkgs, projection }:
pkgs.runCommand "ordinary-resource-consumers"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.jdk
    ];
  }
  ''
    python - <<'PY'
    import functools, hashlib, http.server, json, pathlib, threading, urllib.request
    root = pathlib.Path('${projection}')
    catalog = json.loads((root / 'catalog.json').read_text())
    assert catalog['files']
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory='${projection.documentRoot}')
    with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = 'http://127.0.0.1:' + str(server.server_port)
            with open('resources.txt', 'w') as expected:
                for name, record in sorted(catalog['files'].items()):
                    contents = urllib.request.urlopen(base + '/' + urllib.parse.quote(name)).read()
                    assert hashlib.sha256(contents).hexdigest() == record['sha256']
                    expected.write(name + '\t' + record['sha256'] + '\n')
            for hidden in ('catalog.json', 'nix-support/inputs'):
                if hidden not in catalog['files']:
                    try:
                        urllib.request.urlopen(base + '/' + hidden)
                        raise AssertionError('served metadata: ' + hidden)
                    except urllib.error.HTTPError as error:
                        assert error.code == 404
        finally:
            server.shutdown()
            thread.join()
    PY
    cat > Resources.java <<'JAVA'
    import java.nio.file.*;
    import java.security.MessageDigest;
    import java.util.HexFormat;
    public class Resources {
      public static void main(String[] args) throws Exception {
        for (String line : Files.readAllLines(Path.of("resources.txt"))) {
          String[] parts = line.split("\t", 2);
          try (var stream = Resources.class.getResourceAsStream("/" + parts[0])) {
            if (stream == null) throw new AssertionError(parts[0]);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(stream.readAllBytes()));
            if (!digest.equals(parts[1])) throw new AssertionError(parts[0]);
          }
        }
      }
    }
    JAVA
    javac Resources.java
    java -cp .:${projection.classPath} Resources
    touch $out
  ''
