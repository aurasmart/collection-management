"""Payment-token primitives (docs/adr/0001-token-storage.md).

Phase 0 ships the primitives only. The payment-request feature that uses them is Phase 4.
Tokens, ciphertexts and keys must never be logged or returned in list/detail responses.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_AAD = b"payment-token:v1"
_NONCE_BYTES = 12


def generate_token() -> str:
    """256-bit CSPRNG, URL-safe."""
    return secrets.token_urlsafe(32)


def hash_token(token: str, hmac_secret: str) -> str:
    """Deterministic lookup hash (HMAC-SHA256, hex)."""
    return hmac.new(hmac_secret.encode(), token.encode(), hashlib.sha256).hexdigest()


def encrypt_token(token: str, enc_key_b64: str) -> bytes:
    """AES-256-GCM. Output = nonce || ciphertext+tag."""
    key = base64.b64decode(enc_key_b64)
    nonce = os.urandom(_NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, token.encode(), _AAD)


def decrypt_token(blob: bytes, enc_key_b64: str) -> str:
    key = base64.b64decode(enc_key_b64)
    nonce, ct = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
    return AESGCM(key).decrypt(nonce, ct, _AAD).decode()
