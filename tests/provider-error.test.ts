import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeProviderError } from '../lib/provider-error';

test('provider diagnostic preserves known code and exact boilerplate only', () => {
    assert.deepEqual(safeProviderError({error:{code:'invalid_request',message:'API key not valid. Please pass a valid API key.'}}), {
        code:'invalid_request',message:'API key not valid. Please pass a valid API key.',message_redacted:false,
    });
    assert.deepEqual(safeProviderError({error:{error:{code:400,message:'Request contains an invalid argument.'}}}), {
        code:400,message:'Request contains an invalid argument.',message_redacted:false,
    });
});

test('user-observed multiple-authentication boilerplate is exact-match only', () => {
    const message='Multiple authentication credentials received. Please pass only one.';
    assert.deepEqual(safeProviderError({error:{code:'invalid_request',message}}),{code:'invalid_request',message,message_redacted:false});
    assert.deepEqual(safeProviderError({error:{code:'invalid_request',message:message+' secret-key'}}),{code:'invalid_request',message_redacted:true});
});

test('provider diagnostic drops unknown text, keys, URLs, prompts, media and metadata', () => {
    const result=safeProviderError({error:{
        code:'secret-code',message:'API key not valid. Please pass a valid API key. private prompt https://private.test token=secret-key',
        headers:{authorization:'Bearer secret-key'},details:[{input:'private input',data:'media-base64',signature:'private-signature'}],
    },headers:{secret:'secret-header'},stack:'private-stack'});
    assert.deepEqual(result,{message_redacted:true});
    assert.doesNotMatch(JSON.stringify(result),/private|secret|media|https/);
    assert.deepEqual(safeProviderError({error:{code:'invalid_request',message:'x'.repeat(10000)}}),{code:'invalid_request',message_redacted:true});
    assert.equal(safeProviderError(new Error('private prompt and credential')),undefined);
    assert.equal(safeProviderError(new Error('x'.repeat(10000))),undefined);
});

test('provider diagnostic refuses configured secret and provider identifiers even inside known text', () => {
    assert.deepEqual(safeProviderError({error:{code:'invalid_request',message:'Permission denied.'}},['Permission','invalid_request']),{message_redacted:true});
    assert.deepEqual(safeProviderError({message:JSON.stringify({error:{code:'INVALID_ARGUMENT',message:'Request contains an invalid argument.'}})}),{
        code:'INVALID_ARGUMENT',message:'Request contains an invalid argument.',message_redacted:false,
    });
    assert.deepEqual(safeProviderError({error:{code:Infinity,message:'Permission denied.\nprivate data'}}),{message_redacted:true});
});
