import type { Auth } from 'firebase-admin/auth';
import { describe, expect, it } from 'vitest';

import { FirebaseAuthPort } from '../../functions/src/auth/firebase-auth-port';
import {
  AuthInvalidPhoneError,
  AuthPhoneAlreadyExistsError,
  AuthUnavailableError,
  type AuthPortError,
} from '../../functions/src/identity/errors';

const PHONE = '+919876543210';
const USER = { uid: 'uid_1', phoneNumber: PHONE, disabled: false };

function firebaseError(code: string): Error {
  const error = new Error(code);
  (error as Error & { code?: string }).code = code;
  return error;
}

function authStub(handlers: {
  readonly getUser?: (uid: string) => Promise<unknown>;
  readonly getUserByPhoneNumber?: (e164: string) => Promise<unknown>;
  readonly createUser?: (properties: unknown) => Promise<unknown>;
}): Auth {
  return {
    getUser:
      handlers.getUser ??
      (async () => {
        throw new Error('unexpected getUser');
      }),
    getUserByPhoneNumber:
      handlers.getUserByPhoneNumber ??
      (async () => {
        throw new Error('unexpected getUserByPhoneNumber');
      }),
    createUser:
      handlers.createUser ??
      (async () => {
        throw new Error('unexpected createUser');
      }),
  } as unknown as Auth;
}

async function capture<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('FirebaseAuthPort lookups', () => {
  it('projects a record by UID', async () => {
    const port = new FirebaseAuthPort(
      authStub({ getUser: async () => ({ ...USER, email: 'stripped@example.test' }) }),
    );

    await expect(port.getUser('uid_1')).resolves.toEqual({
      uid: 'uid_1',
      phoneNumber: PHONE,
      disabled: false,
    });
  });

  it('preserves the disabled flag on UID and phone lookups', async () => {
    const disabledUser = { ...USER, disabled: true };
    const port = new FirebaseAuthPort(
      authStub({
        getUser: async () => disabledUser,
        getUserByPhoneNumber: async () => disabledUser,
      }),
    );

    await expect(port.getUser('uid_1')).resolves.toMatchObject({ disabled: true });
    await expect(port.getUserByPhoneNumber(PHONE)).resolves.toMatchObject({ disabled: true });
  });

  it('maps user-not-found to null on UID and phone lookups', async () => {
    const port = new FirebaseAuthPort(
      authStub({
        getUser: async () => {
          throw firebaseError('auth/user-not-found');
        },
        getUserByPhoneNumber: async () => {
          throw firebaseError('auth/user-not-found');
        },
      }),
    );

    await expect(port.getUser('missing')).resolves.toBeNull();
    await expect(port.getUserByPhoneNumber(PHONE)).resolves.toBeNull();
  });

  it('maps invalid phone on lookup to AuthInvalidPhoneError', async () => {
    const port = new FirebaseAuthPort(
      authStub({
        getUserByPhoneNumber: async () => {
          throw firebaseError('auth/invalid-phone-number');
        },
      }),
    );

    const error = await capture(port.getUserByPhoneNumber('not-a-phone'));
    expect(error).toBeInstanceOf(AuthInvalidPhoneError);
    expect((error as AuthPortError).authErrorCode).toBe('auth/invalid-phone-number');
  });

  it('maps transient and unknown lookup failures to AuthUnavailableError', async () => {
    const transient = new FirebaseAuthPort(
      authStub({
        getUser: async () => {
          throw firebaseError('auth/internal-error');
        },
      }),
    );
    const unknown = new FirebaseAuthPort(
      authStub({
        getUser: async () => {
          throw 'non-error value';
        },
      }),
    );

    const transientError = await capture(transient.getUser('uid_1'));
    const unknownError = await capture(unknown.getUser('uid_1'));
    expect(transientError).toBeInstanceOf(AuthUnavailableError);
    expect((transientError as AuthPortError).authErrorCode).toBe('auth/internal-error');
    expect(unknownError).toBeInstanceOf(AuthUnavailableError);
    expect((unknownError as AuthPortError).authErrorCode).toBeNull();
    expect(unknownError).not.toBeInstanceOf(AuthPhoneAlreadyExistsError);
  });
});

describe('FirebaseAuthPort creation', () => {
  it('creates a user with the canonical phone and projects the record', async () => {
    let received: unknown;
    const port = new FirebaseAuthPort(
      authStub({
        createUser: async (properties) => {
          received = properties;
          return USER;
        },
      }),
    );

    await expect(port.createUserWithPhone(PHONE)).resolves.toEqual({
      uid: 'uid_1',
      phoneNumber: PHONE,
      disabled: false,
    });
    expect(received).toEqual({ phoneNumber: PHONE });
  });

  it('maps the observed duplicate-phone code to AuthPhoneAlreadyExistsError', async () => {
    const port = new FirebaseAuthPort(
      authStub({
        createUser: async () => {
          throw firebaseError('auth/phone-number-already-exists');
        },
      }),
    );

    const error = await capture(port.createUserWithPhone(PHONE));
    expect(error).toBeInstanceOf(AuthPhoneAlreadyExistsError);
    expect((error as AuthPortError).authErrorCode).toBe('auth/phone-number-already-exists');
    expect((error as Error).message).not.toContain('9876543210');
    expect((error as Error).message).not.toContain('+91');
  });

  it('maps the documented duplicate-phone alias deliberately and exactly', async () => {
    const port = new FirebaseAuthPort(
      authStub({
        createUser: async () => {
          throw firebaseError('auth/phone-already-exists');
        },
      }),
    );

    const error = await capture(port.createUserWithPhone(PHONE));
    expect(error).toBeInstanceOf(AuthPhoneAlreadyExistsError);
    expect((error as AuthPortError).authErrorCode).toBe('auth/phone-already-exists');
  });

  it('maps invalid phone on creation to AuthInvalidPhoneError', async () => {
    const port = new FirebaseAuthPort(
      authStub({
        createUser: async () => {
          throw firebaseError('auth/invalid-phone-number');
        },
      }),
    );

    const error = await capture(port.createUserWithPhone('not-a-phone'));
    expect(error).toBeInstanceOf(AuthInvalidPhoneError);
  });

  it('never maps unrelated or unknown failures to duplicate-phone errors', async () => {
    const unrelated = new FirebaseAuthPort(
      authStub({
        createUser: async () => {
          throw firebaseError('auth/internal-error');
        },
      }),
    );
    const unknown = new FirebaseAuthPort(
      authStub({
        createUser: async () => {
          throw new Error('something else');
        },
      }),
    );

    const unrelatedError = await capture(unrelated.createUserWithPhone(PHONE));
    const unknownError = await capture(unknown.createUserWithPhone(PHONE));
    expect(unrelatedError).toBeInstanceOf(AuthUnavailableError);
    expect(unrelatedError).not.toBeInstanceOf(AuthPhoneAlreadyExistsError);
    expect(unknownError).toBeInstanceOf(AuthUnavailableError);
    expect(unknownError).not.toBeInstanceOf(AuthPhoneAlreadyExistsError);
  });
});
