import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Bot, ExternalLink } from 'lucide-react';
import { defineMessages, useIntl } from '../../../../i18n';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Button } from '../../../ui/button';
import { QUICKSTART_GUIDE_URL } from '../../providers/modal/constants';
import { Select } from '../../../ui/Select';
import {
  acpListProviderDetails,
  acpReadThinkingEffort,
  acpSaveThinkingEffort,
} from '../../../../acp/providers';
import { useModelAndProvider } from '../../../ModelAndProviderContext';
import type { View } from '../../../../utils/navigationUtils';
import Model, {
  fetchModelReasoning,
  fetchModelsForProviders,
  getProviderMetadata,
} from '../modelInterface';
import type { ProviderDetails, ProviderType, ThinkingEffort } from '../../../../types/providers';
import { trackModelChanged } from '../../../../utils/analytics';
import { addToRecentModels } from '../../../../utils/recentModels';

const i18n = defineMessages({
  thinkingEffortOff: {
    id: 'switchModelModal.thinkingEffortOff',
    defaultMessage: 'Off - No extended thinking',
  },
  thinkingLevelLow: {
    id: 'switchModelModal.thinkingLevelLow',
    defaultMessage: 'Low - Better latency, lighter reasoning',
  },
  thinkingLevelHigh: {
    id: 'switchModelModal.thinkingLevelHigh',
    defaultMessage: 'High - Deeper reasoning, higher latency',
  },
  claudeEffortLow: {
    id: 'switchModelModal.claudeEffortLow',
    defaultMessage: 'Low - Minimal thinking, fastest responses',
  },
  claudeEffortMedium: {
    id: 'switchModelModal.claudeEffortMedium',
    defaultMessage: 'Medium - Moderate thinking',
  },
  claudeEffortHigh: {
    id: 'switchModelModal.claudeEffortHigh',
    defaultMessage: 'High - Deep reasoning (default)',
  },
  claudeEffortMax: {
    id: 'switchModelModal.claudeEffortMax',
    defaultMessage: 'Max - No constraints on thinking depth',
  },
  selectModel: {
    id: 'switchModelModal.selectModel',
    defaultMessage: 'Please select a model',
  },
  selectProvider: {
    id: 'switchModelModal.selectProvider',
    defaultMessage: 'Please select a provider',
  },
  selectOrEnterModel: {
    id: 'switchModelModal.selectOrEnterModel',
    defaultMessage: 'Please select or enter a model',
  },
  title: {
    id: 'switchModelModal.title',
    defaultMessage: 'Switch models',
  },
  description: {
    id: 'switchModelModal.description',
    defaultMessage: 'Select a provider and model to use for your conversations.',
  },
  chooseModel: {
    id: 'switchModelModal.chooseModel',
    defaultMessage: 'Choose a model:',
  },
  recommended: {
    id: 'switchModelModal.recommended',
    defaultMessage: 'Recommended',
  },
  thinkingLevel: {
    id: 'switchModelModal.thinkingLevel',
    defaultMessage: 'Thinking Level',
  },
  geminiOnly: {
    id: 'switchModelModal.geminiOnly',
    defaultMessage: '(Gemini 3 models only)',
  },
  selectThinkingLevel: {
    id: 'switchModelModal.selectThinkingLevel',
    defaultMessage: 'Select thinking level',
  },
  useOtherProvider: {
    id: 'switchModelModal.useOtherProvider',
    defaultMessage: 'Use other provider',
  },
  providerPlaceholder: {
    id: 'switchModelModal.providerPlaceholder',
    defaultMessage: 'Provider, type to search',
  },
  localModelsTitle: {
    id: 'switchModelModal.localModelsTitle',
    defaultMessage: 'Local models need to be downloaded first',
  },
  localModelsDescription: {
    id: 'switchModelModal.localModelsDescription',
    defaultMessage:
      'To use local inference, you need to download a model to your computer first. Go to Settings → Models to manage local models.',
  },
  goToSettings: {
    id: 'switchModelModal.goToSettings',
    defaultMessage: 'Go to Settings',
  },
  couldNotContactProvider: {
    id: 'switchModelModal.couldNotContactProvider',
    defaultMessage: 'Could not contact provider',
  },
  checkProviderConfig: {
    id: 'switchModelModal.checkProviderConfig',
    defaultMessage: 'Check your provider configuration in Settings → Providers',
  },
  loadingModels: {
    id: 'switchModelModal.loadingModels',
    defaultMessage: 'Loading models…',
  },
  selectModelPlaceholder: {
    id: 'switchModelModal.selectModelPlaceholder',
    defaultMessage: 'Select a model, type to search',
  },
  customModelName: {
    id: 'switchModelModal.customModelName',
    defaultMessage: 'Custom model name',
  },
  backToModelList: {
    id: 'switchModelModal.backToModelList',
    defaultMessage: 'Back to model list',
  },
  typeModelName: {
    id: 'switchModelModal.typeModelName',
    defaultMessage: 'Type model name here',
  },
  extendedThinking: {
    id: 'switchModelModal.extendedThinking',
    defaultMessage: 'Extended Thinking',
  },
  selectThinkingMode: {
    id: 'switchModelModal.selectThinkingMode',
    defaultMessage: 'Select thinking mode',
  },
  thinkingEffort: {
    id: 'switchModelModal.thinkingEffort',
    defaultMessage: 'Thinking Effort',
  },
  selectEffortLevel: {
    id: 'switchModelModal.selectEffortLevel',
    defaultMessage: 'Select effort level',
  },
  thinkingBudget: {
    id: 'switchModelModal.thinkingBudget',
    defaultMessage: 'Thinking Budget (tokens)',
  },
  quickStartGuide: {
    id: 'switchModelModal.quickStartGuide',
    defaultMessage: 'Quick start guide',
  },
  cancel: {
    id: 'switchModelModal.cancel',
    defaultMessage: 'Cancel',
  },
  selectModelButton: {
    id: 'switchModelModal.selectModelButton',
    defaultMessage: 'Select model',
  },
  enterModelNotListed: {
    id: 'switchModelModal.enterModelNotListed',
    defaultMessage: 'Enter a model not listed...',
  },
  claudeAdaptive: {
    id: 'switchModelModal.claudeAdaptive',
    defaultMessage: 'Adaptive - Claude decides when and how much to think',
  },
  claudeEnabled: {
    id: 'switchModelModal.claudeEnabled',
    defaultMessage: 'Enabled - Fixed token budget for thinking',
  },
  claudeDisabled: {
    id: 'switchModelModal.claudeDisabled',
    defaultMessage: 'Disabled - No extended thinking',
  },
});

// Thinking effort options are created inside the component to support i18n.

type SwitchModelModalProps = {
  sessionId: string | null;
  onClose: () => void;
  setView: (view: View) => void;
  onModelSelected?: (model: string, provider: string) => void;
  initialProvider?: string | null;
  titleOverride?: string;
  sessionModel?: string | null;
  sessionProvider?: string | null;
};
export const SwitchModelModal = ({
  sessionId,
  onClose,
  setView,
  onModelSelected,
  initialProvider,
  titleOverride,
  sessionModel,
  sessionProvider,
}: SwitchModelModalProps) => {
  const intl = useIntl();

  const THINKING_EFFORT_OPTIONS: { value: ThinkingEffort; label: string }[] = [
    { value: 'off', label: intl.formatMessage(i18n.thinkingEffortOff) },
    { value: 'low', label: intl.formatMessage(i18n.claudeEffortLow) },
    { value: 'medium', label: intl.formatMessage(i18n.claudeEffortMedium) },
    { value: 'high', label: intl.formatMessage(i18n.claudeEffortHigh) },
    { value: 'max', label: intl.formatMessage(i18n.claudeEffortMax) },
  ];

  const {
    changeModel,
    currentModel: configModel,
    currentProvider: configProvider,
  } = useModelAndProvider();
  // Use session-specific model/provider if available, otherwise fall back to config defaults
  const currentModel = sessionModel ?? configModel;
  const currentProvider = sessionProvider ?? configProvider;
  const selectedProvider =
    initialProvider === 'saygm' || currentProvider === 'saygm' ? 'saygm' : null;
  const [providerOptions, setProviderOptions] = useState<{ value: string; label: string }[]>([]);
  type ModelOption = {
    value: string;
    label: string;
    provider: string;
    isDisabled?: boolean;
    reasoning?: boolean;
  };
  const [modelOptions, setModelOptions] = useState<{ options: ModelOption[] }[]>([]);
  const [provider, setProvider] = useState<string | null>(selectedProvider);
  const [model, setModel] = useState<string>(
    selectedProvider === 'saygm' && currentProvider === 'saygm' ? currentModel || '' : ''
  );
  const [validationErrors, setValidationErrors] = useState({
    provider: '',
    model: '',
  });
  const [isValid, setIsValid] = useState(true);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [loadingModels, setLoadingModels] = useState<boolean>(false);
  const [userClearedModel, setUserClearedModel] = useState(false);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [providerWarnings, setProviderWarnings] = useState<Record<string, string>>({});
  const [activeProvidersList, setActiveProvidersList] = useState<ProviderDetails[]>([]);
  const fetchedProviders = useRef<Set<string>>(new Set());
  const reasoningRequestId = useRef(0);
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort | null>(null);
  const [selectedModelReasoning, setSelectedModelReasoning] = useState<boolean | null>(null);

  const modelReasoning = selectedModelReasoning;
  const showThinkingControl = modelReasoning === true;
  const resolveSelectedModelReasoning = useCallback(
    (providerName: string, modelName: string, fallback?: boolean) => {
      const requestId = ++reasoningRequestId.current;
      setSelectedModelReasoning(fallback ?? null);
      fetchModelReasoning(providerName, modelName, fallback).then((reasoning) => {
        if (requestId === reasoningRequestId.current) {
          setSelectedModelReasoning(reasoning);
        }
      });
    },
    []
  );

  useEffect(() => {
    (async () => {
      try {
        const effort = await acpReadThinkingEffort();
        if (effort) setThinkingEffort(effort);
      } catch (e) {
        console.warn('Could not read thinking effort, using default:', e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!provider || !model) return;

    const selectedOption = modelOptions
      .flatMap((group) => group.options)
      .find((option) => option.provider === provider && option.value === model);

    if (selectedOption) {
      resolveSelectedModelReasoning(provider, model, selectedOption.reasoning);
      return;
    }

    setSelectedModelReasoning(null);
    const timeout = setTimeout(() => {
      resolveSelectedModelReasoning(provider, model);
    }, 400);

    return () => clearTimeout(timeout);
  }, [model, provider, modelOptions, resolveSelectedModelReasoning]);

  // Validate form data
  const validateForm = useCallback(() => {
    const errors = {
      provider: '',
      model: '',
    };
    let formIsValid = true;

    if (provider !== 'saygm') {
      errors.provider = intl.formatMessage(i18n.selectProvider);
      formIsValid = false;
    }

    const isCatalogModel = modelOptions
      .flatMap((group) => group.options)
      .some((option) => option.provider === provider && option.value === model);
    if (!model || !isCatalogModel) {
      errors.model = intl.formatMessage(i18n.selectOrEnterModel);
      formIsValid = false;
    }

    setValidationErrors(errors);
    setIsValid(formIsValid);
    return formIsValid;
  }, [model, modelOptions, provider, intl]);

  const handleClose = () => {
    onClose();
  };

  const handleSubmit = async () => {
    setAttemptedSubmit(true);
    const isFormValid = validateForm();

    if (isFormValid) {
      const providerMetaData = await getProviderMetadata(provider || '');
      const providerDisplayName = providerMetaData.display_name;
      let modelObj: Model = {
        name: model,
        provider: 'saygm',
        subtext: providerDisplayName,
      };
      modelObj = {
        ...modelObj,
        reasoning: selectedModelReasoning ?? modelObj.reasoning,
      };

      if (showThinkingControl) {
        const effort = thinkingEffort ?? modelObj.request_params?.thinking_effort ?? 'off';
        modelObj = {
          ...modelObj,
          request_params: { ...modelObj.request_params, thinking_effort: effort },
        };
        acpSaveThinkingEffort(effort).catch(console.warn);
      }

      const success = await changeModel(sessionId, modelObj);
      if (success) {
        trackModelChanged(modelObj.provider || '', modelObj.name);
        if (currentModel && currentProvider === 'saygm') {
          const current = (await window.electron.getSetting('recentModels')) ?? [];
          await window.electron.setSetting(
            'recentModels',
            addToRecentModels(current, currentProvider, currentModel)
          );
        }
        onModelSelected?.(modelObj.name, modelObj.provider || '');
      }

      onClose();
    }
  };

  // Re-validate when inputs change and after attempted submission
  useEffect(() => {
    if (attemptedSubmit) {
      validateForm();
    }
  }, [attemptedSubmit, validateForm]);

  // For manual mode: one-time sync of provider/model when session data
  // arrives after the modal has already mounted. Uses a ref so it only
  // fires once and doesn't interfere with user-driven changes (e.g.
  // switching provider clears model intentionally).
  const manualSyncDone = useRef(false);
  useEffect(() => {
    if (manualSyncDone.current || currentProvider !== 'saygm') return;
    if (initialProvider && initialProvider !== currentProvider) return;
    if (currentModel && currentProvider) {
      if (!provider) setProvider(currentProvider);
      if (!model) setModel(currentModel);
      manualSyncDone.current = true;
    }
  }, [currentModel, currentProvider, provider, model, initialProvider]);

  useEffect(() => {
    (async () => {
      try {
        const providersResponse = await acpListProviderDetails();
        const activeProviders = providersResponse.filter(
          (provider) => provider.name === 'saygm' && provider.is_configured
        );
        setActiveProvidersList(activeProviders);
        setProviderOptions(
          activeProviders.map(({ metadata, name }) => ({
            value: name,
            label: metadata.display_name,
          }))
        );
      } catch (error: unknown) {
        console.error('Failed to query providers:', error);
      }
    })();
  }, [intl]);

  useEffect(() => {
    if (!provider) return;
    if (fetchedProviders.current.has(provider)) {
      setLoadingModels(false);
      return;
    }

    const activeProvider = activeProvidersList.find((p) => p.name === provider);
    if (!activeProvider) return;

    let cancelled = false;

    (async () => {
      setLoadingModels(true);
      try {
        const results = await fetchModelsForProviders([activeProvider]);

        if (cancelled) return;

        const newGroupedOptions: {
          options: (ModelOption & { providerType: ProviderType })[];
        }[] = [];
        const newErrors: Record<string, string> = {};
        const newWarnings: Record<string, string> = {};

        results.forEach(({ provider: p, models, error, warning }) => {
          if (warning) {
            newWarnings[p.name] = warning;
          }
          if (error) {
            newErrors[p.name] = error;
            return;
          }

          const modelList = models || [];

          const options: {
            value: string;
            label: string;
            provider: string;
            providerType: ProviderType;
            reasoning?: boolean;
          }[] = modelList.map((m) => ({
            value: m.name,
            label: m.name,
            provider: p.name,
            providerType: p.provider_type,
            reasoning: m.reasoning,
          }));

          if (options.length > 0) {
            newGroupedOptions.push({ options });
          }
        });

        setProviderErrors((prev) => {
          const next = { ...prev, ...newErrors };
          if (!newErrors[activeProvider.name]) delete next[activeProvider.name];
          return next;
        });
        setProviderWarnings((prev) => {
          const next = { ...prev, ...newWarnings };
          if (!newWarnings[activeProvider.name]) delete next[activeProvider.name];
          return next;
        });

        setModelOptions((prev) => [...prev, ...newGroupedOptions]);
        setOriginalModelOptions((prev) => [...prev, ...newGroupedOptions]);
        fetchedProviders.current.add(provider);
      } catch (error: unknown) {
        console.error(`Failed to fetch models for ${provider}:`, error);
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      setLoadingModels(false);
    };
  }, [provider, activeProvidersList, intl]);

  const filteredModelOptions = useMemo(
    () => (provider ? modelOptions.filter((group) => group.options[0]?.provider === provider) : []),
    [modelOptions, provider]
  );
  const providerModels = useMemo(
    () => filteredModelOptions.flatMap((group) => group.options),
    [filteredModelOptions]
  );

  useEffect(() => {
    // Don't auto-select if user explicitly cleared the model
    if (!provider || loadingModels || model || userClearedModel) return;

    // Use saved model from provider config if available
    const providerInfo = activeProvidersList.find((p) => p.name === provider);
    if (
      providerInfo?.saved_model &&
      providerModels.some((option) => option.value === providerInfo.saved_model)
    ) {
      setModel(providerInfo.saved_model);
    }
  }, [provider, providerModels, loadingModels, model, userClearedModel, activeProvidersList]);

  useEffect(() => {
    if (!provider || loadingModels || !model || !fetchedProviders.current.has(provider)) return;
    const isCatalogModel = modelOptions
      .flatMap((group) => group.options)
      .some((option) => option.provider === provider && option.value === model);
    if (!isCatalogModel) setModel('');
  }, [provider, model, modelOptions, loadingModels]);

  // Handle model selection change
  const handleModelChange = (newValue: unknown) => {
    const selectedOption = newValue as {
      value: string;
      label: string;
      provider: string;
      reasoning?: boolean;
    } | null;
    if (selectedOption === null) {
      // User cleared the selection
      setModel('');
      setSelectedModelReasoning(null);
      setUserClearedModel(true);
    } else {
      setModel(selectedOption?.value || '');
      setProvider(selectedOption?.provider || '');
      if (selectedOption?.provider && selectedOption.value) {
        resolveSelectedModelReasoning(
          selectedOption.provider,
          selectedOption.value,
          selectedOption.reasoning
        );
      } else {
        setSelectedModelReasoning(selectedOption?.reasoning ?? null);
      }
      setUserClearedModel(false);
    }
  };

  // Store the original model options in state, initialized from modelOptions
  const [originalModelOptions, setOriginalModelOptions] =
    useState<{ options: ModelOption[] }[]>(modelOptions);

  const handleInputChange = (inputValue: string) => {
    if (!provider) return;

    const trimmedInput = inputValue.trim();

    if (trimmedInput === '') {
      // Reset to original model options when input is cleared
      setModelOptions([...originalModelOptions]); // Create new array to ensure state update
      return;
    }

    // Filter through the original model options to find matches
    const matchingOptions = originalModelOptions
      .map((group) => ({
        options: group.options.filter((option) =>
          option.value.toLowerCase().includes(trimmedInput.toLowerCase())
        ),
      }))
      .filter((group) => group.options.length > 0);
    setModelOptions(matchingOptions);
  };

  const thinkingEffortControl = showThinkingControl && (
    <div className="mt-2">
      <label className="text-sm text-textSubtle mb-1 block">
        {intl.formatMessage(i18n.thinkingEffort)}
      </label>
      <Select
        options={THINKING_EFFORT_OPTIONS}
        value={THINKING_EFFORT_OPTIONS.find((o) => o.value === (thinkingEffort ?? 'off'))}
        onChange={(newValue: unknown) => {
          const option = newValue as { value: ThinkingEffort; label: string } | null;
          setThinkingEffort(option?.value || 'off');
        }}
        placeholder={intl.formatMessage(i18n.selectEffortLevel)}
      />
    </div>
  );

  return (
    <Dialog open={true} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot size={24} className="text-text-primary" />
            {titleOverride || intl.formatMessage(i18n.title)}
          </DialogTitle>
          <DialogDescription>{intl.formatMessage(i18n.description)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          <div className="w-full flex flex-col gap-4">
            <div>
              <Select
                options={providerOptions}
                value={providerOptions.find((option) => option.value === provider) || null}
                onChange={(newValue: unknown) => {
                  const option = newValue as { value: string; label: string } | null;
                  setProvider(option?.value === 'saygm' ? 'saygm' : null);
                  setModel('');
                  setUserClearedModel(false);
                }}
                placeholder={intl.formatMessage(i18n.providerPlaceholder)}
                isClearable
              />
              {attemptedSubmit && validationErrors.provider && (
                <div className="text-red-500 text-sm mt-1">{validationErrors.provider}</div>
              )}
            </div>

            {provider && (
              <>
                {provider === 'local' &&
                !loadingModels &&
                filteredModelOptions.flatMap((g) => g.options).filter((o) => o.value !== 'custom')
                  .length === 0 ? (
                  /* Show special UI for local provider when no models are downloaded */
                  <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4">
                    <div className="flex flex-col gap-3">
                      <div>
                        <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200">
                          {intl.formatMessage(i18n.localModelsTitle)}
                        </h3>
                        <div className="mt-1 text-sm text-blue-700 dark:text-blue-300">
                          {intl.formatMessage(i18n.localModelsDescription)}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setView('settings');
                          onClose();
                        }}
                        className="self-start border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
                      >
                        {intl.formatMessage(i18n.goToSettings)}
                      </Button>
                    </div>
                  </div>
                ) : providerErrors[provider] ? (
                  <div className="flex flex-col gap-2">
                    <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3">
                      <div className="flex items-start">
                        <div className="flex-1">
                          <h3 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                            {intl.formatMessage(i18n.couldNotContactProvider)}
                          </h3>
                          <div className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
                            {providerErrors[provider]}
                          </div>
                          <div className="mt-2 text-xs text-yellow-600 dark:text-yellow-400">
                            {intl.formatMessage(i18n.checkProviderConfig)}
                          </div>
                        </div>
                      </div>
                    </div>
                    {attemptedSubmit && validationErrors.model && (
                      <div className="text-red-500 text-sm mt-1">{validationErrors.model}</div>
                    )}
                  </div>
                ) : (
                  <div>
                    <Select
                      options={
                        loadingModels
                          ? []
                          : filteredModelOptions.length > 0
                            ? filteredModelOptions
                            : []
                      }
                      onChange={handleModelChange}
                      onInputChange={handleInputChange}
                      value={
                        loadingModels
                          ? {
                              value: '',
                              label: intl.formatMessage(i18n.loadingModels),
                              isDisabled: true,
                            }
                          : model
                            ? { value: model, label: model }
                            : null
                      }
                      placeholder={intl.formatMessage(i18n.selectModelPlaceholder)}
                      isClearable
                      isDisabled={loadingModels}
                    />

                    {attemptedSubmit && validationErrors.model && (
                      <div className="text-red-500 text-sm mt-1">{validationErrors.model}</div>
                    )}
                    {provider && providerWarnings[provider] && (
                      <div className="rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3 mt-2">
                        <div className="text-sm text-yellow-700 dark:text-yellow-300">
                          {providerWarnings[provider]}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {thinkingEffortControl}
              </>
            )}
          </div>
        </div>

        <DialogFooter className="pt-4 flex-col sm:flex-row gap-3">
          <a
            href={QUICKSTART_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-text-secondary hover:text-text-primary text-sm mr-auto"
          >
            <ExternalLink size={14} className="mr-1" />
            {intl.formatMessage(i18n.quickStartGuide)}
          </a>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleClose} type="button">
              {intl.formatMessage(i18n.cancel)}
            </Button>
            <Button onClick={handleSubmit} disabled={!isValid}>
              {intl.formatMessage(i18n.selectModelButton)}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
