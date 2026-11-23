// Types shared by the hosted page's parts.

/** What the header says about the save: polling a connected file, waiting for permission, an unreadable file, or upload mode. */
export type HostedWatch = 'polling' | 'needs-permission' | 'unreadable' | 'upload';
