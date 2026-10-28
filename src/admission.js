/**
 * Inbound admission: may this WeChat sender drive the agent?
 *
 * Kept free of DSH imports so it is loadable and testable outside a profile.
 * @module dsh-weixin-ilink/admission
 */

/**
 * @param {{ allowedSenders?: readonly string[], firstContact: { senderId: string }, senderId: string, allowFirstContact?: boolean }} input
 * @returns {'allow' | 'allow-first' | 'deny'}
 */
export function admission({ allowedSenders, firstContact, senderId, allowFirstContact = false }) {
  const list = Array.isArray(allowedSenders) ? allowedSenders : []
  // A configured list is authoritative: no first-contact fallback.
  if (list.length > 0) return list.includes(senderId) ? 'allow' : 'deny'
  // Empty list: deny unless the operator explicitly opts into first-contact setup.
  if (allowFirstContact !== true) return 'deny'
  // Allow exactly one sender for this instance (fresh-bind setup).
  if (firstContact.senderId === '') return 'allow-first'
  return firstContact.senderId === senderId ? 'allow' : 'deny'
}

/**
 * Group-chat gate. Groups stay off unless switched on, and even then only the
 * configured rooms are served; a mention requirement is applied by the caller.
 *
 * @param {{ groupChatEnabled?: boolean, allowedGroups?: readonly string[], groupId: string }} input
 * @returns {'allow' | 'deny'}
 */
export function groupAdmission({ groupChatEnabled, allowedGroups, groupId }) {
  if (groupChatEnabled !== true) return 'deny'
  const list = Array.isArray(allowedGroups) ? allowedGroups : []
  if (list.length === 0) return 'allow' // every group, mentions still required
  return list.includes(groupId) ? 'allow' : 'deny'
}
