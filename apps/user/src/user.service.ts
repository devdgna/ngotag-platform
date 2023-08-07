import * as bcrypt from 'bcrypt';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';

import { ClientRegistrationService } from '@credebl/client-registration';
import { CommonService } from '@credebl/common';
import { EmailDto } from '@credebl/common/dtos/email.dto';
import { InternalServerErrorException } from '@nestjs/common';
import { LoginUserDto } from '../dtos/login-user.dto';
import { OrgRoles } from 'libs/org-roles/enums';
import { OrgRolesService } from '@credebl/org-roles';
import { PrismaService } from '@credebl/prisma-service';
import { ResponseMessages } from '@credebl/common/response-messages';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { URLUserEmailTemplate } from '../templates/user-url-template';
import { UserOrgRolesService } from '@credebl/user-org-roles';
import { UserRepository } from '../repositories/user.repository';
import { VerifyEmailTokenDto } from '../dtos/verify-email.dto';
import { sendEmail } from '@credebl/common/send-grid-helper-file';
// eslint-disable-next-line camelcase
import { user } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { InvitationsI, UserEmailVerificationDto, userInfo } from '../interfaces/user.interface';
import { AcceptRejectInvitationDto } from '../dtos/accept-reject-invitation.dto';


@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientRegistrationService: ClientRegistrationService,
    private readonly commonService: CommonService,
    private readonly orgRoleService: OrgRolesService,
    private readonly userOrgRoleService: UserOrgRolesService,
    private readonly userRepository: UserRepository,
    private readonly logger: Logger,
    @Inject('NATS_CLIENT') private readonly userServiceProxy: ClientProxy
  ) { }

  /**
   *
   * @param userEmailVerificationDto
   * @returns
   */
  async sendVerificationMail(userEmailVerificationDto: UserEmailVerificationDto): Promise<user> {
    try {
      const userDetails = await this.userRepository.checkUserExist(userEmailVerificationDto.email);

      if (userDetails && userDetails.isEmailVerified) {
        throw new ConflictException(ResponseMessages.user.error.exists);
      }

      if (userDetails && !userDetails.isEmailVerified) {
        throw new ConflictException(ResponseMessages.user.error.verificationAlreadySent);
      }

      const resUser = await this.userRepository.createUser(userEmailVerificationDto);

      try {
        await this.sendEmailForVerification(userEmailVerificationDto.email, resUser.verificationCode);
      } catch (error) {
        throw new InternalServerErrorException(ResponseMessages.user.error.emailSend);
      }

      return resUser;
    } catch (error) {
      this.logger.error(`In Create User : ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  /**
   *
   * @param email
   * @param orgName
   * @param verificationCode
   * @returns
   */

  async sendEmailForVerification(email: string, verificationCode: string): Promise<boolean> {
    try {
      const platformConfigData = await this.prisma.platform_config.findMany();

      const urlEmailTemplate = new URLUserEmailTemplate();
      const emailData = new EmailDto();
      emailData.emailFrom = platformConfigData[0].emailFrom;
      emailData.emailTo = email;
      emailData.emailSubject = `${process.env.PLATFORM_NAME} Platform: Email Verification`;

      emailData.emailHtml = await urlEmailTemplate.getUserURLTemplate(email, verificationCode, 'USER');
      const isEmailSent = await sendEmail(emailData);
      if (isEmailSent) {
        return isEmailSent;
      } else {
        throw new InternalServerErrorException(ResponseMessages.user.error.emailSend);
      }

    } catch (error) {
      this.logger.error(`error in create keycloak user: ${JSON.stringify(error)}`);
      throw new InternalServerErrorException(error.message);
    }
  }


  /**
   *
   * @param param email, verification code
   * @returns Email verification succcess
   */

  async verifyEmail(param: VerifyEmailTokenDto): Promise<object> {
    try {
      const invalidMessage = ResponseMessages.user.error.invalidEmailUrl;

      if (!param.verificationCode || !param.email) {
        throw new UnauthorizedException(invalidMessage);
      }

      const userDetails = await this.userRepository.getUserDetails(param.email);

      if (!userDetails || param.verificationCode !== userDetails.verificationCode) {
        throw new UnauthorizedException(invalidMessage);
      }

      if (userDetails.isEmailVerified) {
        throw new ConflictException(ResponseMessages.user.error.verifiedEmail);
      }

      if (param.verificationCode === userDetails.verificationCode) {
        await this.userRepository.verifyUser(param.email);
        return {
          message: "User Verified sucessfully"
        };
      }
    } catch (error) {
      this.logger.error(`error in verifyEmail: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  /**
  *
  * @param param email, verification code
  * @returns Email verification succcess
  */

  async createUserInKeyCloak(email: string, userInfo: userInfo): Promise<string> {
    try {
      if (!email) {
        throw new UnauthorizedException(ResponseMessages.user.error.invalidEmail);
      }
      const checkUserDetails = await this.userRepository.getUserDetails(email);
      if (!checkUserDetails) {
        throw new NotFoundException(ResponseMessages.user.error.invalidEmail);
      }
      if (checkUserDetails.keycloakUserId) {
        throw new ConflictException(ResponseMessages.user.error.exists);
      }
      if (false === checkUserDetails.isEmailVerified) {
        throw new NotFoundException(ResponseMessages.user.error.verifyEmail);
      }
      const resUser = await this.userRepository.updateUserInfo(email, userInfo);
      if (!resUser) {
        throw new NotFoundException(ResponseMessages.user.error.invalidEmail);
      }
      const userDetails = await this.userRepository.getUserDetails(email);

      if (!userDetails) {
        throw new NotFoundException(ResponseMessages.user.error.adduser);
      }
      const clientManagementToken = await this.clientRegistrationService.getManagementToken();

      const keycloakDetails = await this.keycloakUserRegistration(userDetails, clientManagementToken);

      await this.userRepository.updateUserDetails(
        userDetails.id,
        keycloakDetails
      );

      const holderRoleData = await this.orgRoleService.getRole(OrgRoles.HOLDER);
      await this.userOrgRoleService.createUserOrgRole(userDetails.id, holderRoleData.id);

      return "User created successfully";
    } catch (error) {
      this.logger.error(`error in create keycloak user: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  /**
   *
   * @param userName
   * @param clientToken
   * @returns Keycloak client details
   */
  async keycloakClienGenerate(userName: string, clientToken: string): Promise<{ clientId; clientSecret }> {
    try {
      const userClient = await this.clientRegistrationService.createClient(userName, clientToken);

      return userClient;
    } catch (error) {
      this.logger.error(`error in keycloakClienGenerate: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   *
   * @param keycloakUserRegestrationDto
   * @returns Email verification succcess
   */

  async keycloakUserRegistration(userDetails: user, clientToken: string): Promise<string> {
    const keycloakRegistrationPayload = {
      email: userDetails.email,
      firstName: userDetails.firstName,
      lastName: userDetails.lastName,
      username: userDetails.username,
      enabled: true,
      totp: true,
      emailVerified: true,
      notBefore: 0,
      credentials: [
        {
          type: 'password',
          value: `${userDetails.password}`,
          temporary: false
        }
      ],
      access: {
        manageGroupMembership: true,
        view: true,
        mapRoles: true,
        impersonate: true,
        manage: true
      },
      realmRoles: ['user', 'offline_access'],
      attributes: {
        uid: [],
        homedir: [],
        shell: []
      }
    };

    try {
      const createUserResponse = await this.clientRegistrationService.registerKeycloakUser(
        keycloakRegistrationPayload,
        process.env.KEYCLOAK_CREDEBL_REALM,
        clientToken
      );

      return createUserResponse?.keycloakUserId;
    } catch (error) {
      this.logger.error(`error in keycloakUserRegistration: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
   *
   * @param loginUserDto
   * @returns User access token details
   */
  async login(loginUserDto: LoginUserDto): Promise<object> {
    const { email, password, isPasskey } = loginUserDto;

    try {
      const userData = await this.userRepository.checkUserExist(email);

      if (!userData) {
        throw new NotFoundException(ResponseMessages.user.error.notFound);
      }

      if (userData && !userData.isEmailVerified) {
        throw new BadRequestException(ResponseMessages.user.error.verifyMail);
      }

      if (true === isPasskey && false === userData?.isFidoVerified) {
        throw new UnauthorizedException(ResponseMessages.user.error.registerFido);
      }

      if (true === isPasskey && userData?.username && true === userData?.isFidoVerified) {
        //Get user token from keycloak
        const token = await this.clientRegistrationService.getUserToken(email, userData.password);
        return token;
      }

      const comparePassword = await bcrypt.compare(password, userData.password);

      if (!comparePassword) {
        this.logger.error(`Password Is wrong`);
        throw new BadRequestException(ResponseMessages.user.error.invalidCredentials);
      }

      //Get user token from kelycloak
      const token = await this.clientRegistrationService.getUserToken(email, userData.password);
      return token;
    } catch (error) {
      this.logger.error(`In Login User : ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  async getProfile(payload: { id }): Promise<object> {
    try {
      return this.userRepository.getUserById(payload.id);
    } catch (error) {
      this.logger.error(`get user: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  async findByKeycloakId(payload: { id }): Promise<object> {
    try {
      return this.userRepository.getUserByKeycloakId(payload.id);
    } catch (error) {
      this.logger.error(`get user: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  async findUserByEmail(payload: { email }): Promise<object> {
    try {
      return this.userRepository.findUserByEmail(payload.email);
    } catch (error) {
      this.logger.error(`findUserByEmail: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  async invitations(payload: { id; status; pageNumber; pageSize; search; }): Promise<object> {
    try {
      const userData = await this.userRepository.getUserById(payload.id);

      if (!userData) {
        throw new NotFoundException(ResponseMessages.user.error.notFound);
      }

      const invitationsData = await this.getOrgInvitations(
        userData.email,
        payload.status,
        payload.pageNumber,
        payload.pageSize,
        payload.search
      );

      const invitations: InvitationsI[] = await this.updateOrgInvitations(invitationsData['invitations']);
      invitationsData['invitations'] = invitations;
      return invitationsData;
    } catch (error) {
      this.logger.error(`Error in get invitations: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  async getOrgInvitations(email: string, status: string, pageNumber: number, pageSize: number, search = ''): Promise<object> {
    const pattern = { cmd: 'fetch-user-invitations' };
    const payload = {
      email, status, pageNumber, pageSize, search
    };

    const invitationsData = await this.userServiceProxy
      .send(pattern, payload)
      .toPromise()
      .catch((error) => {
        this.logger.error(`catch: ${JSON.stringify(error)}`);
        throw new HttpException(
          {
            status: error.status,
            error: error.message
          },
          error.status
        );
      });

    return invitationsData;
  }

  async updateOrgInvitations(invitations: InvitationsI[]): Promise<InvitationsI[]> {
    const updatedInvitations = [];

    for (const invitation of invitations) {
      const { status, id, organisation, orgId, userId, orgRoles } = invitation;

      const roles = await this.orgRoleService.getOrgRolesByIds(orgRoles as number[]);

      updatedInvitations.push({
        orgRoles: roles,
        status,
        id,
        orgId,
        organisation,
        userId
      });
    }

    return updatedInvitations;
  }

  /**
   *
   * @param acceptRejectInvitation
   * @param userId
   * @returns Organization invitation status
   */
  async acceptRejectInvitations(acceptRejectInvitation: AcceptRejectInvitationDto, userId: number): Promise<string> {
    try {
      const userData = await this.userRepository.getUserById(userId);
      return this.fetchInvitationsStatus(acceptRejectInvitation, userId, userData.email);
    } catch (error) {
      this.logger.error(`acceptRejectInvitations: ${error}`);
      throw new RpcException(error.response);
    }
  }

  /**
   *
   * @param acceptRejectInvitation
   * @param userId
   * @param email
   * @returns
   */
  async fetchInvitationsStatus(
    acceptRejectInvitation: AcceptRejectInvitationDto,
    userId: number,
    email: string
  ): Promise<string> {
    try {
      const pattern = { cmd: 'update-invitation-status' };

      const { orgId, invitationId, status } = acceptRejectInvitation;

      const payload = { userId, orgId, invitationId, status, email };

      const invitationsData = await this.userServiceProxy
        .send(pattern, payload)
        .toPromise()
        .catch((error) => {
          this.logger.error(`catch: ${JSON.stringify(error)}`);
          throw new HttpException(
            {
              statusCode: error.statusCode,
              error: error.message
            },
            error.error
          );
        });

      return invitationsData;
    } catch (error) {
      this.logger.error(`Error In fetchInvitationsStatus: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  /**
   * 
   * @param orgId 
   * @returns users list
   */
  async get(orgId: number, pageNumber: number, pageSize: number, search: string): Promise<object> {
    try {
      const query = {
        userOrgRoles: {
          some: { orgId }
        },
        OR: [
          { firstName: { contains: search } },
          { lastName: { contains: search } },
          { email: { contains: search } }
        ]
      };

      const filterOptions = {
        orgId
      };
      return this.userRepository.findUsers(query, pageNumber, pageSize, filterOptions);
    } catch (error) {
      this.logger.error(`get Users: ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }

  async checkUserExist(email: string): Promise<string | object> {
    try {
      const userDetails = await this.userRepository.checkUniqueUserExist(email);
      if (userDetails && !userDetails.isEmailVerified) {

        throw new ConflictException(ResponseMessages.user.error.verificationAlreadySent);
      } else if (userDetails && userDetails.keycloakUserId) {
        throw new ConflictException(ResponseMessages.user.error.exists);
      } else if (null === userDetails) {
        return 'New User';
      } else {
        const userVerificationDetails = {
          isEmailVerified: userDetails.isEmailVerified,
          isFidoVerified: userDetails.isFidoVerified,
          isKeycloak: null !== userDetails.keycloakUserId && undefined !== userDetails.keycloakUserId
        };
        return userVerificationDetails;
      }

    } catch (error) {
      this.logger.error(`In check User : ${JSON.stringify(error)}`);
      throw new RpcException(error.response);
    }
  }
}