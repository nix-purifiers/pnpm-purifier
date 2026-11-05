# SPDX-License-Identifier: MIT
{ pkgs, build }:
let
  manifest = builtins.fromJSON (builtins.readFile ./fixtures/webjar/package.json);
  built = build {
    src = ./fixtures/webjar;
    webAssets.${manifest.name} = "public";
  };
  projected = built.packages.${manifest.name}.projections;
  view = projected.maven;
  artifact = builtins.replaceStrings [ "@" "/" ] [ "" "__" ] manifest.name;
  resource = "META-INF/resources/webjars/${artifact}/${manifest.version}/proof.mjs";
  invalid =
    path:
    builtins.tryEval (
      (build {
        src = ./fixtures/webjar;
        webAssets.${manifest.name} = path;
      }).projections
    );
  unknown = builtins.tryEval (
    (build {
      src = ./fixtures/webjar;
      webAssets.missing = "public";
    }).projections
  );
in
assert !unknown.success;
assert builtins.all (path: !(invalid path).success) [
  "."
  "../public"
  "node_modules"
  "/public"
];
pkgs.runCommand "browser-webjar-ordinary-consumers"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.nodejs
      pkgs.jdk
      pkgs.gradle
    ];
  }
  ''
    test -e ${
      import ./resource-consumer.nix {
        inherit pkgs;
        projection = projected.resources;
      }
    }
    node --input-type=module - <<'JS'
    import answer from 'file://${projected.resources.directory}/proof.mjs';
    if (answer !== 42) throw new Error('asset dependency did not resolve');
    JS
    export HOME="$TMPDIR/home" GRADLE_USER_HOME="$TMPDIR/gradle"
    mkdir -p "$HOME"
    python - <<'PY'
    import json, pathlib, zipfile
    catalog = json.load(open('${view.catalog}'))
    module, = catalog['modules']
    open('coordinate', 'w').write(f"{module['group']}:{module['name']}:{module['version']}")
    jar, = pathlib.Path('${view}').rglob('*.jar')
    with zipfile.ZipFile(jar) as archive:
        assert not any('node_modules' in name or '.env' in name or 'build.cjs' in name for name in archive.namelist())
        assert b'helper.mjs' in archive.read('${resource}')
    PY
    cat > settings.gradle <<'GRADLE'
    rootProject.name = 'ordinary-webjar-consumer'
    GRADLE
    cat > build.gradle <<'GRADLE'
    repositories { maven { url = uri('${view}') } }
    configurations { assets }
    dependencies { assets file('coordinate').text }
    tasks.register('verify') {
      doLast {
        def jar = new java.util.jar.JarFile(configurations.assets.singleFile)
        def resource = jar.getJarEntry('${resource}')
        assert jar.getInputStream(resource).text.contains('helper.mjs')
        jar.close()
      }
    }
    GRADLE
    gradle --offline --no-daemon verify
    test -n "$(find ${built.projections.ivy} -name '*.jar')"
    touch $out
  ''
