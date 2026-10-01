import { createHash, timingSafeEqual } from 'crypto';

function hashOtp(otp) {
  return createHash('sha256').update(otp).digest('hex');
}

function verifyOtp(plain, hashed) {
  const plainHash = Buffer.from(hashOtp(plain));
  const stored   = Buffer.from(hashed);
  if (plainHash.length !== stored.length) return false;
  return timingSafeEqual(plainHash, stored);
}

const h1 = hashOtp('1234');
const h2 = hashOtp('1234');
console.assert(h1 === h2,       'FAIL: same OTP should hash identically');
console.assert(h1.length === 64, 'FAIL: SHA-256 hex should be 64 chars');
const h3 = hashOtp('5678');
console.assert(h1 !== h3,      'FAIL: different OTPs should hash differently');
console.assert(verifyOtp('1234', h1),  'FAIL: correct OTP should verify');
console.assert(!verifyOtp('9999', h1), 'FAIL: wrong OTP should not verify');
console.log('All OTP security tests pass.');
