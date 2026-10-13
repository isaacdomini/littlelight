package app.tinyglow.passkeys;

import android.os.Build;
import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException;
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException;
import androidx.credentials.exceptions.CreateCredentialUnsupportedException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;
import androidx.credentials.exceptions.domerrors.DomError;
import androidx.credentials.exceptions.domerrors.NotAllowedError;
import androidx.credentials.exceptions.domerrors.SecurityError;
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException;
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Bridge `TinyglowPasskeys` (docs/plans/step-13.md 2.6): the platform passkey ceremonies through
 * Credential Manager, so the relying party is `tinyglow.app` (the WebView origin can never be a
 * WebAuthn origin). Same JSON contract as iOS; the mapping lives in PasskeyJson (JVM-tested).
 *
 *   available()                                   -> { available }   Android 9+ (passkeys need API 28
 *                                                    and Google Play services; the Credential Manager
 *                                                    library handles the Play services bridge)
 *   create({ options })                           -> { credential }  CreatePublicKeyCredentialRequest
 *   get({ options, preferImmediatelyAvailable? })  -> { credential }  GetCredentialRequest(GetPublicKeyCredentialOption)
 *
 * Rejections (call.reject(message, code); message == code, nothing from the OS):
 *   cancelled       the user dismissed the sheet (also DOM NotAllowedError, which covers timeouts)
 *   not_available   no credential provider / Play services, Android < 9
 *   not_configured  the options name another RP than tinyglow.app (dev stack), or the app's
 *                   origin is not accepted (assetlinks `get_login_creds` or the apk-key-hash origin
 *                   missing at GoTrue; DOM SecurityError)
 *   failed          anything else, including "no passkey on this device" (NoCredentialException)
 *
 * The app's WebAuthn origin at GoTrue is android:apk-key-hash:<base64url(sha256(signing cert))>, one
 * per signing key (NATIVE.md). Options, credential JSON and OS error messages are never logged.
 */
@CapacitorPlugin(name = "TinyglowPasskeys")
public class TinyglowPasskeysPlugin extends Plugin {

    static final String CANCELLED = "cancelled";
    static final String NOT_AVAILABLE = "not_available";
    static final String NOT_CONFIGURED = "not_configured";
    static final String FAILED = "failed";

    private final AtomicBoolean busy = new AtomicBoolean(false);

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P);
        call.resolve(ret);
    }

    @PluginMethod
    public void create(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) { reject(call, NOT_AVAILABLE); return; }
        JSObject options = call.getObject("options");
        if (options == null) { reject(call, FAILED); return; }
        String requestJson;
        try {
            requestJson = PasskeyJson.creationRequest(options, PasskeyJson.RP_ID);
        } catch (PasskeyJson.WrongRelyingParty e) {
            reject(call, NOT_CONFIGURED);
            return;
        } catch (PasskeyJson.BadOptions e) {
            reject(call, FAILED);
            return;
        }
        if (!busy.compareAndSet(false, true)) { reject(call, FAILED); return; }
        CredentialManager manager = CredentialManager.create(getContext());
        manager.createCredentialAsync(
            getActivity(),
            new CreatePublicKeyCredentialRequest(requestJson),
            null,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override
                public void onResult(CreateCredentialResponse result) {
                    busy.set(false);
                    if (!(result instanceof CreatePublicKeyCredentialResponse)) { reject(call, FAILED); return; }
                    deliver(call, ((CreatePublicKeyCredentialResponse) result).getRegistrationResponseJson(), true);
                }

                @Override
                public void onError(CreateCredentialException e) {
                    busy.set(false);
                    reject(call, classifyCreate(e));
                }
            }
        );
    }

    @PluginMethod
    public void get(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) { reject(call, NOT_AVAILABLE); return; }
        JSObject options = call.getObject("options");
        if (options == null) { reject(call, FAILED); return; }
        String requestJson;
        try {
            requestJson = PasskeyJson.assertionRequest(options, PasskeyJson.RP_ID);
        } catch (PasskeyJson.WrongRelyingParty e) {
            reject(call, NOT_CONFIGURED);
            return;
        } catch (PasskeyJson.BadOptions e) {
            reject(call, FAILED);
            return;
        }
        if (!busy.compareAndSet(false, true)) { reject(call, FAILED); return; }
        boolean immediate = Boolean.TRUE.equals(call.getBoolean("preferImmediatelyAvailable", false));
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPublicKeyCredentialOption(requestJson))
            .setPreferImmediatelyAvailableCredentials(immediate)
            .build();
        CredentialManager manager = CredentialManager.create(getContext());
        manager.getCredentialAsync(
            getActivity(),
            request,
            null,
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    busy.set(false);
                    Credential credential = result.getCredential();
                    if (!(credential instanceof PublicKeyCredential)) { reject(call, FAILED); return; }
                    deliver(call, ((PublicKeyCredential) credential).getAuthenticationResponseJson(), false);
                }

                @Override
                public void onError(GetCredentialException e) {
                    busy.set(false);
                    reject(call, classifyGet(e));
                }
            }
        );
    }

    private void deliver(PluginCall call, String responseJson, boolean registration) {
        try {
            JSONObject credential = PasskeyJson.credential(new JSONObject(responseJson), registration);
            JSObject ret = new JSObject();
            ret.put("credential", JSObject.fromJSONObject(credential));
            call.resolve(ret);
        } catch (JSONException | PasskeyJson.BadOptions e) {
            reject(call, FAILED);
        }
    }

    static String classifyCreate(CreateCredentialException e) {
        if (e instanceof CreateCredentialCancellationException) return CANCELLED;
        if (e instanceof CreateCredentialProviderConfigurationException
            || e instanceof CreateCredentialUnsupportedException
            || e instanceof CreateCredentialNoCreateOptionException) return NOT_AVAILABLE;
        if (e instanceof CreatePublicKeyCredentialDomException) {
            return classifyDom(((CreatePublicKeyCredentialDomException) e).getDomError());
        }
        return FAILED;
    }

    static String classifyGet(GetCredentialException e) {
        if (e instanceof GetCredentialCancellationException) return CANCELLED;
        if (e instanceof GetCredentialProviderConfigurationException
            || e instanceof GetCredentialUnsupportedException) return NOT_AVAILABLE;
        if (e instanceof GetPublicKeyCredentialDomException) {
            return classifyDom(((GetPublicKeyCredentialDomException) e).getDomError());
        }
        // No passkey for tinyglow.app on this device: the JS side offers the email code.
        if (e instanceof NoCredentialException) return FAILED;
        return FAILED;
    }

    private static String classifyDom(DomError error) {
        if (error instanceof NotAllowedError) return CANCELLED;
        if (error instanceof SecurityError) return NOT_CONFIGURED;
        return FAILED;
    }

    private static void reject(PluginCall call, String code) {
        call.reject(code, code);
    }
}
