export interface ResourceProvisioningResult {
    success: boolean;
    provisioned: Array<{
        placeholder: string;
        resourceType: 'KV' | 'D1';
        resourceId: string;
        binding?: string;
    }>;
    failed: Array<{
        placeholder: string;
        resourceType: 'KV' | 'D1';
        error: string;
        binding?: string;
    }>;
    replacements: Record<string, string>;
    wranglerUpdated: boolean;
}

export interface ResourceProvisioningOptions {
    projectName: string;
    instanceId: string;
    continueOnError: boolean;
}

export interface WranglerConfigValidationResult {
    isValid: boolean;
    hasPlaceholders: boolean;
    unresolvedPlaceholders: string[];
    errors?: string[];
}

export interface InstanceMetadata {
    projectName: string;
    startTime: string;
    webhookUrl?: string;
    previewURL?: string;
    tunnelURL?: string;
    processId?: string;
    allocatedPort?: number;
    donttouch_files: string[];
    redacted_files: string[];
}