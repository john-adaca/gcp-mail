export const generateEmailFromPattern = (
  firstName,
  lastName,
  domain,
  pattern
) => {
  const first = firstName.toLowerCase();
  const last = lastName.toLowerCase();

  switch (pattern) {
    case "firstname":
      return `${first}@${domain}`;
    case "firstname.lastname":
      return `${first}.${last}@${domain}`;
    case "firstnamelastname":
      return `${first}${last}@${domain}`;
    case "f.lastname":
      return `${first[0]}.${last}@${domain}`;
    case "flastname":
      return `${first[0]}${last}@${domain}`;
    default:
      return `${first}.${last}@${domain}`;
  }
};

export const detectPatternFromEmail = (email, firstName, lastName) => {
  const [localPart] = email.split("@");
  const first = firstName.toLowerCase();
  const last = lastName.toLowerCase();

  if (localPart === first) return "firstname";
  if (localPart === `${first}.${last}`) return "firstname.lastname";
  if (localPart === `${first}${last}`) return "firstnamelastname";
  if (localPart === `${first[0]}.${last}`) return "f.lastname";
  if (localPart === `${first[0]}${last}`) return "flastname";

  return null;
};

export const inferPatternFromEmail = (email) => {
  const [localPart] = email.split("@");

  // Simple pattern detection based on email format
  if (localPart.includes(".") && localPart.split(".").length === 2) {
    return "firstname.lastname";
  } else if (localPart.length <= 10 && /^[a-z]+$/.test(localPart)) {
    return "firstname";
  } else if (localPart.length > 10 && !localPart.includes(".")) {
    return "firstnamelastname";
  } else if (localPart.includes(".") && localPart.split(".")[0].length === 1) {
    return "f.lastname";
  } else if (
    localPart.length <= 8 &&
    localPart[1] &&
    /^[a-z][a-z]+$/.test(localPart)
  ) {
    return "flastname";
  }

  return "unknown";
};
