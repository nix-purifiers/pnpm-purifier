"""Exercise real sockets inside the project builder's Nix sandbox."""
import errno
import json
import socket
import sys

for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
    with socket.socket(socket.AF_INET, kind) as server:
        server.settimeout(3)
        server.bind(('127.0.0.1', 0))
        address = server.getsockname()
        with socket.socket(socket.AF_INET, kind) as client:
            client.settimeout(3)
            if kind == socket.SOCK_STREAM:
                server.listen(1)
                client.connect(address)
                with server.accept()[0] as accepted:
                    client.sendall(b'locked-registry')
                    assert accepted.recv(64) == b'locked-registry'
            else:
                client.sendto(b'locked-registry', address)
                assert server.recvfrom(64)[0] == b'locked-registry'

external = []
if sys.platform == 'darwin':
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        with socket.socket(socket.AF_INET, kind) as client:
            client.settimeout(3)
            try:
                if kind == socket.SOCK_STREAM:
                    client.connect(('192.0.2.1', 9))
                else:
                    client.sendto(b'denied', ('192.0.2.1', 9))
            except OSError as error:
                assert error.errno in (errno.EPERM, errno.EACCES), repr(error)
                external.append(error.errno)
            else:
                raise AssertionError('Darwin sandbox allowed external socket operation')
print(json.dumps({'loopback': ['tcp', 'udp'], 'darwinExternalDeniedErrnos': external}))
