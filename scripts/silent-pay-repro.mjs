// Minimal reproduction — uses only @silent-pay/core's own public API.
//   npm i @silent-pay/core secp256k1 bitcoinjs-lib && node repro.mjs
import { createOutputs, scanOutputs, createInputHash, encodeSilentPaymentAddress } from '@silent-pay/core';
import secp256k1 from 'secp256k1';
import { networks } from 'bitcoinjs-lib';
import { randomBytes } from 'node:crypto';

const hex = (b) => Buffer.from(b).toString('hex');

// A receiver's keys.
const scanPriv = new Uint8Array(randomBytes(32));
const spendPriv = new Uint8Array(randomBytes(32));
const scanPub = secp256k1.publicKeyCreate(scanPriv, true);
const spendPub = secp256k1.publicKeyCreate(spendPriv, true);
const address = encodeSilentPaymentAddress(scanPub, spendPub, networks.bitcoin);

// A sender pays that address from one input.
const inputPriv = new Uint8Array(randomBytes(32));
const inputPub = secp256k1.publicKeyCreate(inputPriv, true);
const outpoint = { txid: Buffer.alloc(32, 7).toString('hex'), vout: 0 };
const outputs = createOutputs(
  [{ key: hex(inputPriv), isXOnly: false }],
  outpoint,
  [{ address, amount: 1000 }],
  networks.bitcoin,
);

// The receiver scans that transaction. Same arguments both times.
const inputHash = createInputHash(inputPub, outpoint);
const candidates = [outputs[0].script];

const before = hex(scanPriv);
const first = scanOutputs(scanPriv, spendPub, inputPub, inputHash, [...candidates]);
const after = hex(scanPriv);
const second = scanOutputs(scanPriv, spendPub, inputPub, inputHash, [...candidates]);

console.log('scan key before scanOutputs :', before);
console.log('scan key after  scanOutputs :', after);
console.log('scan key was mutated        :', before !== after);
console.log();
console.log('first scan  → matches found :', first.size);
console.log('second scan → matches found :', second.size, '   <-- same tx, same key, no match');
console.log();
console.log(before !== after && first.size === 1 && second.size === 0
  ? 'REPRODUCED: the caller\'s scan private key is overwritten, so every later scan fails.'
  : 'not reproduced');
